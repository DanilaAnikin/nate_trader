/* ==========================================================================
 * verdict.mjs — completeness first, then the matrix, then a verdict
 *
 * ORDER MATTERS, AND IT USED NOT TO
 * ---------------------------------
 * The old file evaluated eight claims by looking for evidence of violation.
 * That made an absent observer indistinguishable from a clean result: with the
 * in-process instrument missing from a container, `noBodyParse`,
 * `noSupabaseClient` and `noBrokerCall` produced no failure string and no
 * warning, and the row printed a green dash for a request that had provably
 * parsed a body and constructed a client. `marksReadable`, `instrumentEnv` and
 * `bootEvents` were written by the driver and never read here.
 *
 * So this file now does three things in order, and refuses to reach the third
 * unless the first two hold:
 *
 *  1. IDENTITY AND CARDINALITY, against a committed request manifest. Exactly
 *     the pinned SET of cell identities — not merely the pinned NUMBER of them
 *     — exactly the pinned number of requests, the exact per-cell count, and
 *     the exact set of (method, endpoint, authenticated) triples. A run that
 *     drove fewer requests cannot pass by driving fewer, and a run that drove
 *     ONE combination cannot pass by presenting twenty-four copies of it.
 *
 *  2. COMPLETENESS. Every request carries exactly one record for every claim
 *     in the closed schema. Missing, duplicate, malformed, unknown, skipped,
 *     unexecuted, empty and INDETERMINATE are all hard failures. Removing a
 *     sensor now breaks this check instead of removing a claim.
 *
 *  3. THE VERDICT. Only now are violations counted.
 *
 * A SUBSET WAS BEING CERTIFIED AS THE WHOLE
 * -----------------------------------------
 * This file used to establish cardinality by COUNTING the cell result files in
 * `$OUT/cells` and comparing that count with the manifest. It never looked at
 * WHICH combinations those files described. An adversarial audit reproduced the
 * consequence three ways, each ending in `PASS all 24 environment combinations`
 * and exit 0:
 *
 *   * twenty-three of the twenty-four cell files overwritten with a copy of the
 *     twenty-fourth ("distinct cell identities inside them: 1");
 *   * a real `run.sh --cells 1 --schema 0023` whose single cell was copied to
 *     all twenty-four manifest filenames;
 *   * every cell's recorded `instrumentEnv.raw_freeze_flags` set to one triple.
 *
 * The surviving combination in the reproduction was `m-on__s-on__b-empty` — the
 * MOST frozen one. The cells that would actually catch a leak (maintenance off
 * or absent) are exactly the ones the old check could not distinguish from
 * having been driven.
 *
 * So identity is now checked on three independent statements about each cell,
 * all of which must agree:
 *
 *   (a) the FILENAME says which combination the file is;
 *   (b) the driver's own `cell` field, written inside the container run, says
 *       the same thing, and the per-request `cellTag` prefixes agree with it;
 *   (c) `instrumentEnv.raw_freeze_flags` — the three freeze variables read back
 *       out of the process under test, by the instrument, at run time — equals
 *       the environment the committed manifest pins for that identity.
 *
 * (c) is the load-bearing one: it is a statement about what the container was
 * actually running, not about what a file is called. A copied cell fails it for
 * twenty-three of the twenty-four identities.
 *
 * The driven identity SET must then equal the manifest's pinned set exactly.
 *
 * ...AND THE SAME DEFECT WAS THEN FOUND ONE LEVEL UP (B1/B2/B3)
 * -------------------------------------------------------------
 * The three statements above pin WHICH CELL was driven. Nothing pinned WHICH
 * MIGRATION GENERATION drove it, and all three statements are generation-
 * independent: the freeze flags, the cell name and the cellTags are the same on
 * 0008 and on 0023. A later audit copied one generation's twenty-four result
 * files onto the other generation's filenames and obtained
 *
 *     PASS all 24 environment combinations x 2 migration generations
 *     (48 combinations) ... each was observed running its own freeze-flag triple
 *
 * with exit 0, one real container start, and the pre-tombstone 0008 database
 * never booted. Worse, all three statements are three FIELDS OF ONE FILE
 * written by ONE process, so repairing `instrumentEnv.raw_freeze_flags`
 * alongside the name and the tags defeated the gate outright — while the
 * evidence that would have caught it, `sink-<schema>.jsonl` and `$OUT/instr/`,
 * sat on disk unread.
 *
 * Four things close it, and every one of them is a file this driver did NOT
 * write:
 *
 *   (d) GENERATION. `cell.dbWitness` is a structural fingerprint of `public`
 *       read out of the RUNNING DATABASE by the recording gateway — a
 *       different container — and it must equal the fingerprint this checkout
 *       pins for the generation the filename claims. 0008 and 0023 are not
 *       close (7 routines vs 44), and the two generations' observed
 *       fingerprints must also differ from each other, so neither a copy nor a
 *       wholesale swap survives.
 *   (e) THE GATEWAY'S OWN COPY. The same fingerprint must appear, for the same
 *       cell, in `sink-<schema>.jsonl`, which that gateway container writes to
 *       a host bind mount. And every cellTag must appear in that log: a cell
 *       nobody drove is not in it.
 *   (f) THE IMAGE'S OWN LOG. `$OUT/instr/<schema>-<cell>.jsonl` must exist and
 *       carry an `instrument.loaded` event. It is appended by the process
 *       under test, in a third container, once per real container start.
 *   (g) ONE RUN. `$OUT/provenance.json` states the run, the image and the probe
 *       identity, and every cell must carry that run's nonce — so a directory
 *       assembled from two run.sh invocations is refused rather than certified.
 *
 * ...AND THEN THE OBSERVERS WERE STILL NOT BEING READ (audit findings D, B, C)
 * ---------------------------------------------------------------------------
 * (f) above was the whole of what the image's own log was read for: does it
 * exist, does it say `instrument.loaded`, do the cell's boot events appear in
 * it. Everything after boot — the events the containment claims are actually
 * about — was taken from `results[].events`, THE DRIVER'S TRANSCRIPTION.
 *
 * An adversarial auditor appended two lines to
 * `instr/0023-m-off__s-off__b-probe.jsonl`, inside a request window: a
 * `body.parse` and a `fetch` to `paper-api.alpaca.markets`. Nothing else was
 * touched — no forgery at all, because that file is written by the thing under
 * test and reading it is the entire purpose of the harness. The verdict printed
 * the full certifying PASS with `noBodyParse: 480 satisfied, 0 violated` and
 * `noBrokerCall: 480 satisfied, 0 violated` in its own tally. The harness was
 * inverted: the driver was the thing under test's reporter, and the verdict
 * believed the reporter.
 *
 * Two more forgeries followed from the same root — nothing bound a REQUEST
 * OBSERVATION to the cell or the generation it was observed in, so:
 *   B  0008's twenty-four results were filed under 0023's filenames with
 *      `schema`, `dbWitness` and `bootEvents` pasted out of the real 0023
 *      results already in the directory: PASS.
 *   C  one cell's `results` were pasted into the other twenty-three with the
 *      name, the tags, the freeze flags and `bootEvents` repaired from the
 *      manifest and from the instrument logs the check compares against: PASS,
 *      with 1 distinct request-observation record across 24 certified cells.
 * Both were assembled purely by COPYING values already present in the artefact
 * directory. Neither touched a file the driver did not write.
 *
 * So three more things are read, and every one of them is again a file this
 * driver did not write:
 *
 *   (h) THE WINDOW. The request window for a tag is taken from the recording
 *       gateway's log — its timestamp of the driver's `/__canary/cell` POST for
 *       that tag, to its timestamp of the next tag. Bounded by its own
 *       terminator, and nothing the driver wrote is in it.
 *   (i) THE EVENTS IN IT. `noBodyParse`, `noSupabaseClient`, `noBrokerCall`,
 *       `noDatabaseCall`, `noUnexpectedNetworkCall`, `noAuthCall` and
 *       `noPostgRESTCall` are decided from the events the IMAGE'S OWN LOG
 *       carries in that window. The driver's transcription is still read, and
 *       any difference between the two copies is a hard failure in its own
 *       right: a run whose two records of one measurement disagree has not
 *       measured anything. Re-measured for the ADV round over the four
 *       distinct genuine certifying runs still on this machine, 480 windows
 *       each: 1920 windows, 2385 log events, 0 differences. (An earlier note
 *       here said "720 windows carrying 2179 events"; three of the four sets
 *       behind that figure contributed 240 windows each, which is ONE
 *       generation, and those directories no longer exist. See observers.mjs.)
 *   (i2) EVERY OTHER LINE OF THAT LOG (audit finding ADV-1). A window covers
 *       only the time the driver was issuing requests — measured at 10.8% and
 *       11.7% of the two generations' gateway-observed cell time — so deciding
 *       the claims inside the windows said nothing at all about the other 89%.
 *       An auditor moved the D attack 742 ms past the last window and got the
 *       certifying PASS back, with three events byte-faithful to what
 *       instrument.cjs emit() writes. Every line of the instrument's log must
 *       now be ATTRIBUTED — to the declared boot snapshot or to exactly one
 *       bounded request window — and an unattributed line refuses the run.
 *   (i3) EVERY LINE OF THE GATEWAY'S LOG TOO (round-5 audit). (i2) closed the
 *       complement for observer one and left observer two — the recording
 *       gateway, the one that exists BECAUSE the instrument runs inside the
 *       thing under test — read only as `sinkMap.get(<cell>#<n>)`. A
 *       `GET /rest/v1/accounts` and a `GET /auth/v1/user` logged under one
 *       cell's `#idle` tag, with no instrument event and no cell result
 *       touched, produced a full certifying PASS. Every gateway entry that is
 *       not the harness's own /__canary control traffic must now fall under a
 *       request tag some cell result claims.
 *   (i4) AND THE BOOT BUCKET IS JUDGED BY AN ALLOW-LIST. Its first judge
 *       enumerated four of the eight outbound kinds instrument.cjs emits and
 *       decided from a self-reported `hostClass`; both gaps certified a POST
 *       to paper-api.alpaca.markets. See observers.mjs `bootEventProblem`.
 *   (j) THE OBSERVATION. The driver attests a canonical description of every
 *       request to the gateway as it finishes — status, headers, body digest,
 *       both timestamps, the event and marker digests — and the gateway writes
 *       it into its own log. This file recomputes that description from the
 *       cell result and requires equality, and requires the request's two
 *       timestamps to lie inside (h). A cell result rewritten after the run
 *       now contradicts a file the rewriter did not write. It does NOT
 *       constrain a driver that lies while it runs; see the `artefact-forgery`
 *       scope statement, which says so.
 *       Round-5 audit: the event digest inside that description covered
 *       `[seq, t, kind]` and NOT each event's `detail` — the host, the port,
 *       the path class, the fields the claims are decided from. Rewriting only
 *       the detail, in both instrument-side copies, turned a measured
 *       `noBrokerCall=violated` into a certifying PASS. The attestation is now
 *       version 2 and covers the detail; a directory carrying version 1
 *       attestations refuses, naming the version, rather than certifying from
 *       evidence it does not have.
 *
 * WHAT THE COMMAND LINE MAY NO LONGER DECIDE (audit findings E and F)
 * ------------------------------------------------------------------
 * Two more facts were argv-only, which meant that every re-verification path
 * omitted them by construction:
 *
 *   E  `--pg-image-substituted`. run.sh passes it only when it has just used a
 *      substituted database image; `provenance.json` recorded `pgImage` and
 *      `pgImagePinned` and this file read neither. A run on `postgres:17-alpine`
 *      re-verdicted to a full certifying PASS. Pinned-ness is now RECOMPUTED
 *      from `provenance.pgImage` against the digest the manifest pins.
 *   F  `--sensor-verdict <schema>=TRUSTWORTHY`. Deleting every trusted-runner
 *      artefact and asserting it produced a PASS, and `verdict-scope.json` did
 *      not record the sensor verdict at all. It is now derived from
 *      `sensor-report-<schema>.txt`, argv is cross-checked against the derived
 *      value, and both are written into the scope file.
 *
 * A PARTIAL RUN IS NOT A PASS, AND THE SCHEMA AXIS IS PART OF THE MATRIX
 * ---------------------------------------------------------------------
 * `--cells N` used to print an unqualified "PASS every cell refused with 503
 * and the canary never fired" and exit 0 after driving one of twenty-four
 * combinations. A partial run is now a distinct status, PARTIAL, with its own
 * exit code, and there is no path through this file that prints PASS for one.
 *
 * The same defect existed on the schema axis and was NOT closed: the claim is
 * about both migration generations, so 24 cells x 2 schemas = 48 combinations,
 * and a `--schema 0023` run that drove 24 of 24 cells still printed the
 * unqualified PASS banner. The driven schema set is now folded into PARTIAL the
 * same way the cell set is.
 *
 * A NON-CERTIFYING MANIFEST CANNOT BE PROMOTED
 * --------------------------------------------
 * `tests/k2-claim-completeness.sh` drives synthetic cells that are deliberately
 * not matrix combinations. It therefore uses a SEPARATE committed manifest with
 * `"certifying": false`, and this file refuses to print PASS for one, whatever
 * else holds. A test fixture must not be able to buy a certification.
 *
 * Exit codes:
 *   0  the expectation for this --mode / --break-sensor held, in full
 *   1  a containment finding: the image under test violated a claim
 *   2  the harness itself failed
 *   3  a control misbehaved — nothing this run says can be trusted
 *   4  PARTIAL: the run was deliberately incomplete and cannot be a pass
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CLAIMS, buildClaims, checkCompleteness, summarise,
  classifyGatewayPath, GATEWAY_PATH_CLASSES, GATEWAY_CLASS_READERS,
  HARNESS_SINK_HOST, REQUEST_EGRESS_KINDS,
} from "./claims.mjs";
import {
  gatewayTimeline, instrumentLog, eventsInWindow, diffEventSets, describeEvent,
  attributeEvents, attributeGatewayRows, describeGatewayRow, REQUEST_TAG,
  parseJsonlFile, describeUnparseable, HARNESS_PROTOCOL, gatewayTagClass,
} from "./observers.mjs";
import {
  observationFields, observationDigest, diffObservations, OBSERVATION_VERSION,
  eventForeignKeys, EVENT_TOP_LEVEL_KEYS,
} from "./observation.mjs";

/* ── A TRANSCRIPT THAT SURVIVES process.exit() ──────────────────────────────
 * Node writes to a PIPE asynchronously, and `process.exit()` throws away
 * whatever is still queued. This file ends every path in `process.exit()`, and
 * every suite that reads it captures it with `OUTPUT="$(node verdict.mjs … 2>&1)"`
 * — a pipe. So the transcript silently lost a contiguous middle chunk of
 * itself, at random, and nothing said so.
 *
 * MEASURED on this exact file, one refusal, eight identical captures through a
 * pipe: 330509, 270514, 312498, 92082, 165554, 330509, 330509, 161618 bytes.
 * The 92082-byte capture had lost 177 of the 280 matrix rows AND the whole
 * "WHAT THIS VERDICT DOES NOT SAY" block — the scope statements this
 * programme added precisely so that the limits of a PASS could not be
 * overlooked. Redirected to a FILE instead, the same run is 321660 + 8914
 * bytes every single time.
 *
 * Why that is a correctness problem and not a cosmetic one: several suites
 * assert that a string is ABSENT from this transcript (k4's `no_pass_banner`,
 * k9's equivalents). An absence assertion over output that can lose 72% of
 * itself is satisfied by the loss, so a negative control could pass for the
 * one reason it must never pass for. In the other direction it makes presence
 * assertions flake RED; that was observed once, live, in k2-sensor-removal.
 *
 * The repair is to stop writing asynchronously at all: `fs.writeSync` is
 * synchronous for pipes as well as for files and TTYs, and uses only public
 * API (`process.stdout._handle.setBlocking` also works, and was measured to
 * work, but it is an internal that can vanish without a deprecation). EAGAIN
 * is retried rather than dropped, because a dropped byte here is the defect.
 * ------------------------------------------------------------------------- */
function writeAll(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code === "EAGAIN") continue;      // non-blocking pipe, try again
      if (e.code === "EPIPE") return;          // the reader went away
      throw e;
    }
  }
}
// NT_VERDICT_ASYNC_STDIO=1 restores the ASYNCHRONOUS, lossy writer. It exists
// for exactly one purpose: tests/k13-transcript-integrity.test.sh executes the
// red-before with it, so the repair is demonstrated rather than asserted. It is
// a test seam that can only make the output WORSE — it can never turn a real
// failure into a pass — and the default is the synchronous writer.
/* Everything written to stderr is also kept, colour-stripped, so that a
 * refusal which exits before the verdict stage can still leave a
 * machine-readable record of WHY (audit finding ADV-4, below). Bounded,
 * because a pathological run must not be able to grow this without limit. */
const REFUSAL_LINES = [];
{
  const SYNC_STDIO = process.env.NT_VERDICT_ASYNC_STDIO !== "1";
  const baseError = console.error.bind(console);
  if (SYNC_STDIO) console.log = (...a) => writeAll(1, util.format(...a) + "\n");
  console.error = (...a) => {
    const text = util.format(...a);
    if (REFUSAL_LINES.length < 200) {
      REFUSAL_LINES.push(text.replace(/\x1b\[[0-9;]*m/g, ""));
    }
    if (SYNC_STDIO) writeAll(2, text + "\n"); else baseError(text);
  };
}

const EXIT_FINDING = 1;
const EXIT_HARNESS = 2;
const EXIT_CONTROL = 3;
const EXIT_PARTIAL = 4;

/* ── ADV-4: A STALE GREEN MUST NEVER OUTLIVE THE RUN THAT WROTE IT ──────────
 * `verdict-scope.json` is written on every exit path FROM THE VERDICT STAGE,
 * and the `transcript-vs-this-file` scope statement tells readers to PREFER it
 * over the transcript. But the refusals that happen BEFORE the verdict stage —
 * PROVENANCE_CONTRADICTED, PROVENANCE_MISSING, MANIFEST_MALFORMED,
 * SCHEMA_AXIS_MALFORMED and the rest — printed their reason and exited without
 * touching the file. Over an artefact directory that had already been
 * verdicted, that leaves the PREVIOUS run's `{"status":"PASS"}` sitting on
 * disk after a refusal. MEASURED: 6m46s stale, exit 3 on the console and PASS
 * in the file a reader was told to prefer.
 *
 * Two mechanisms, because one of them has to hold when the other cannot run:
 *
 *   1. the file is DELETED before anything else happens, so even a crash, an
 *      uncaught exception or an exit path added later leaves NO file rather
 *      than a wrong one. Absence is unambiguous; a stale green is not.
 *   2. every refusal writes a terminal document in its place, and a
 *      process-exit hook writes one if nothing else did.
 *
 * `unlinkSync` failing for any reason other than ENOENT stops the run: a
 * verdict that cannot guarantee the file is its own must not produce one. */
function clearStaleScope(out) {
  const p = path.join(out, "verdict-scope.json");
  try { fs.unlinkSync(p); }
  catch (e) {
    if (e.code === "ENOENT") return;
    console.error(`verdict: could not remove the previous ${p}: ${e.message}`);
    console.error("  Refusing to start. A verdict-scope.json this run cannot overwrite would be read as");
    console.error("  this run's verdict; a previous PASS surviving a refusal is audit finding ADV-4.");
    process.exit(EXIT_HARNESS);
  }
}

function args() {
  const a = process.argv.slice(2);
  /* Before the arguments are even validated: an unknown flag exits, and that
   * exit must not leave the previous run's PASS behind either.
   *
   * EVERY `--out`, not the first: the loop below keeps the LAST one, so
   * clearing only `a.indexOf("--out")` would leave a previous run's PASS
   * sitting in the directory this run actually writes to — the same defect
   * this block exists to close, reintroduced by an off-by-one in its own
   * argument scan. Clearing a directory this run then does not write to costs
   * nothing: absence is the safe state. */
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] === "--out" && typeof a[i + 1] === "string" && a[i + 1].length) {
      clearStaleScope(a[i + 1]);
    }
  }
  const o = {
    mode: "frozen", breakSensor: "none", schemas: [],
    cellsRun: null, cellsTotal: null, manifest: null, expectStatus: 503,
    sensorVerdicts: {}, sensorHits: {},
    probeUserId: null, targetDirty: 0, pgImageSubstituted: null,
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--out") o.out = a[++i];
    else if (a[i] === "--mode") o.mode = a[++i];
    else if (a[i] === "--break-sensor") o.breakSensor = a[++i];
    else if (a[i] === "--schemas") o.schemas = a[++i].split(",").filter(Boolean);
    else if (a[i] === "--cells-run") o.cellsRun = Number(a[++i]);
    else if (a[i] === "--cells-total") o.cellsTotal = Number(a[++i]);
    else if (a[i] === "--manifest") o.manifest = a[++i];
    else if (a[i] === "--expect-status") o.expectStatus = Number(a[++i]);
    // The disposable probe identity, so the pinned `__PROBE_USER_ID__`
    // placeholder in the manifest's cellEnv can be compared against what the
    // instrument read back out of the container.
    else if (a[i] === "--probe-user-id") o.probeUserId = a[++i];
    // How many paths the TARGET checkout had modified. Non-zero means the run
    // cannot certify a commit, because the tree it was built from is not one.
    else if (a[i] === "--target-dirty") o.targetDirty = Number(a[++i]);
    // The database image the run actually used, when it was not the pinned
    // production digest. run.sh used to print "confirmed running the pinned
    // production image id" whatever --pg-image said.
    else if (a[i] === "--pg-image-substituted") o.pgImageSubstituted = a[++i];
    else if (a[i] === "--sensor-verdict") {
      const [schema, res] = String(a[++i]).split("=");
      o.sensorVerdicts[schema] = res;
    } else if (a[i] === "--sensor-hits") {
      // Challenge hits the trusted runner caused AFTER the baseline snapshot.
      // They are real movements of the same counters, so they must be
      // accounted for by name rather than filtered out by guesswork.
      const [schema, n] = String(a[++i]).split("=");
      o.sensorHits[schema] = Number(n);
    } else { console.error(`verdict: unknown argument ${a[i]}`); process.exit(EXIT_HARNESS); }
  }
  if (!o.out) { console.error("verdict: --out is required"); process.exit(EXIT_HARNESS); }
  if (!o.manifest) { console.error("verdict: --manifest is required (the committed request manifest)"); process.exit(EXIT_HARNESS); }
  return o;
}

const O = args();

/* ADV-4, part 2. Declared HERE rather than beside `writeScope` at the bottom
 * of the file: the exit hook below can fire during this module's top-level
 * evaluation (PROVENANCE_MISSING exits at that point), and a `let` still in
 * its temporal dead zone would throw inside the hook instead of writing the
 * document the hook exists to write. */
let scopeWritten = false;

/* ADV-4, part 3. Every OTHER exit path.
 *
 * There are twenty-three `process.exit()` calls before the verdict stage —
 * MANIFEST_MALFORMED, PROVENANCE_MISSING, PROVENANCE_CONTRADICTED,
 * SCHEMA_AXIS_MALFORMED, MANIFEST_CLAIM_SET_DRIFT and the rest. Editing each
 * one to write a document would close the twenty-three that exist and nothing
 * about the twenty-fourth somebody adds next round, which is the exact shape
 * of every defect this programme has had to fix twice. So the record is
 * written STRUCTURALLY, from a process-exit hook that cannot be forgotten,
 * carrying the stderr this run actually produced.
 *
 * The refusal CODE is recovered from the first captured stderr line, because
 * every one of those refusals begins with one; when it cannot be recovered the
 * document says NO_VERDICT rather than inventing a code. Either way the
 * `status` is not PASS and `verdictReached` is false, which is the property a
 * downstream reader needs. */
process.on("exit", (code) => {
  if (scopeWritten || !O || !O.out) return;
  scopeWritten = true;
  const first = REFUSAL_LINES.length ? REFUSAL_LINES[0] : "";
  const m = /^([A-Z][A-Z0-9_]{3,})\b/.exec(first);
  try {
    fs.writeFileSync(path.join(O.out, "verdict-scope.json"), JSON.stringify({
      status: m ? m[1] : "NO_VERDICT",
      verdictReached: false,
      exitCode: code,
      reason: REFUSAL_LINES.length
        ? REFUSAL_LINES.join("\n")
        : "verdict.mjs exited without reaching any path that writes a verdict and without printing a " +
          "reason — a crash, or an exit added without one. The absence of a verdict is not a pass.",
      manifest: O.manifest ? path.basename(O.manifest) : null,
      schemasRequested: O.schemas,
      mode: O.mode,
      writtenBy: "the process-exit hook (audit finding ADV-4)",
      note: "This run REFUSED before it could render a verdict, so there is no doesNotClaim block: " +
            "the scope statements describe a verdict that was not reached. verdict.mjs DELETES " +
            "verdict-scope.json before it does anything else, so a PASS in this file is never a " +
            "leftover from an earlier run over the same directory.",
    }, null, 2));
  } catch { /* the process is already leaving; there is nothing further to try */ }
});

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const readLines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean) : []);
/* The checkout this verdict is part of. Expectations that TRUSTED_DIGEST
 * covers — sql/expected-baseline.<gen>.txt, expected/tombstone-state.<gen>.txt
 * — are read from HERE, never from the artefact directory being judged. */
const CANARY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BOLD = "[1m", RED = "[1;31m", GREEN = "[1;32m",
      YELLOW = "[1;33m", OFF = "[0m";

const hardFailures = [];
const hard = (msg) => { hardFailures.push(msg); };

/* -- the committed request manifest --------------------------------------- */
let MANIFEST;
try { MANIFEST = readJson(O.manifest); }
catch (e) {
  console.error(`${RED}MANIFEST_UNREADABLE${OFF} ${O.manifest}: ${e.message}`);
  process.exit(EXIT_HARNESS);
}
for (const k of ["cells", "requestsPerCell", "totalRequests", "claims", "endpoints", "certifying"]) {
  if (!(k in MANIFEST)) {
    console.error(`${RED}MANIFEST_MALFORMED${OFF} missing '${k}'`);
    process.exit(EXIT_HARNESS);
  }
}
if (typeof MANIFEST.certifying !== "boolean") {
  console.error(`${RED}MANIFEST_MALFORMED${OFF} 'certifying' must be a boolean, not ${JSON.stringify(MANIFEST.certifying)}`);
  process.exit(EXIT_HARNESS);
}

/* -- the pinned cell identities -------------------------------------------
 * A certifying manifest must pin WHICH combinations exist and what environment
 * each one is. Without both, "24 cell files" is a statement about a count, and
 * twenty-four copies of one cell satisfies it. A manifest that declines to pin
 * them is a fixture, and a fixture cannot certify.
 */
const CERTIFYING = MANIFEST.certifying === true;
let CELL_IDS = null;      // the pinned identity set, or null for a fixture
let CELL_ENV = null;      // id -> {VAR: expected raw value|null}
let MANIFEST_SCHEMAS = null;
let CELL_ID_PATTERN = null;
let NEEDS_PROBE = false;

if (CERTIFYING) {
  for (const k of ["cellIds", "cellEnv", "schemas", "schemaWitness", "pinnedPgImage"]) {
    if (!(k in MANIFEST)) {
      console.error(`${RED}MANIFEST_MALFORMED${OFF} a certifying manifest must pin '${k}'`);
      console.error("  A cell COUNT is not a cell identity: twenty-four copies of one combination");
      console.error("  satisfy a count, and the audit reproduced exactly that PASS.");
      process.exit(EXIT_HARNESS);
    }
  }
  if (!Array.isArray(MANIFEST.cellIds) || MANIFEST.cellIds.length !== MANIFEST.cells) {
    console.error(`${RED}MANIFEST_MALFORMED${OFF} cellIds has ${Array.isArray(MANIFEST.cellIds) ? MANIFEST.cellIds.length : "no"} entries but cells is ${MANIFEST.cells}`);
    process.exit(EXIT_HARNESS);
  }
  CELL_IDS = [...MANIFEST.cellIds];
  if (new Set(CELL_IDS).size !== CELL_IDS.length) {
    console.error(`${RED}MANIFEST_MALFORMED${OFF} cellIds contains duplicates`);
    process.exit(EXIT_HARNESS);
  }
  CELL_ENV = MANIFEST.cellEnv;
  for (const id of CELL_IDS) {
    if (!CELL_ENV || typeof CELL_ENV[id] !== "object" || CELL_ENV[id] === null) {
      console.error(`${RED}MANIFEST_MALFORMED${OFF} cellEnv has no environment pinned for cell '${id}'`);
      process.exit(EXIT_HARNESS);
    }
  }
  if (!Array.isArray(MANIFEST.schemas) || MANIFEST.schemas.length === 0) {
    console.error(`${RED}MANIFEST_MALFORMED${OFF} schemas must be a non-empty array`);
    process.exit(EXIT_HARNESS);
  }
  MANIFEST_SCHEMAS = [...MANIFEST.schemas];
  // The generation each schema name MEANS, as a fingerprint of the running
  // database's own catalogue. Without this the schema is only a filename
  // prefix, which is what let 24 cells be certified as 48.
  for (const s of MANIFEST_SCHEMAS) {
    const w = MANIFEST.schemaWitness && MANIFEST.schemaWitness[s];
    if (!w || typeof w.fingerprint !== "string" || !/^[0-9a-f]{32}$/.test(w.fingerprint)) {
      console.error(`${RED}MANIFEST_MALFORMED${OFF} schemaWitness has no md5 fingerprint pinned for generation '${s}'`);
      console.error("  A cell result carries no generation of its own unless something pins what each");
      console.error("  generation looks like; the audit certified 24 combinations as 48 for want of it.");
      process.exit(EXIT_HARNESS);
    }
  }
  {
    const fps = MANIFEST_SCHEMAS.map((s) => MANIFEST.schemaWitness[s].fingerprint);
    if (new Set(fps).size !== fps.length) {
      console.error(`${RED}MANIFEST_MALFORMED${OFF} two generations are pinned to the SAME fingerprint`);
      console.error("  Then a cell driven on one of them satisfies the other, and the schema axis is decorative.");
      process.exit(EXIT_HARNESS);
    }
  }
  if (typeof MANIFEST.pinnedPgImage !== "string" || !/@sha256:[0-9a-f]{64}$/.test(MANIFEST.pinnedPgImage)) {
    console.error(`${RED}MANIFEST_MALFORMED${OFF} pinnedPgImage must name the production database image BY DIGEST`);
    console.error("  Without it, 'was this run on the pinned image' can only be answered by a command-line");
    console.error("  flag that every re-verification path omits by construction, which is audit finding E.");
    process.exit(EXIT_HARNESS);
  }
  // The probe id is half of the pinned environment for every b-probe cell, so a
  // certifying run that cannot expand the placeholder cannot check them. The
  // requirement is asserted AFTER provenance.json is read, because that is now
  // where the id normally comes from.
  NEEDS_PROBE = CELL_IDS.some((id) =>
    Object.values(CELL_ENV[id]).some((v) => v === "__PROBE_USER_ID__"));
} else {
  if (typeof MANIFEST.cellIdPattern !== "string" || MANIFEST.cellIdPattern.length === 0) {
    console.error(`${RED}MANIFEST_MALFORMED${OFF} a non-certifying manifest must state a cellIdPattern`);
    process.exit(EXIT_HARNESS);
  }
  CELL_ID_PATTERN = new RegExp(MANIFEST.cellIdPattern);
  MANIFEST_SCHEMAS = Array.isArray(MANIFEST.schemas) ? [...MANIFEST.schemas] : null;
}

/** The environment cell `id` must have been OBSERVED running, with the run's
 *  own probe id substituted for the pinned placeholder. */
function expectedRawEnv(id) {
  const pinned = CELL_ENV[id];
  const out = {};
  for (const [k, v] of Object.entries(pinned)) {
    out[k] = v === "__PROBE_USER_ID__" ? O.probeUserId : v;
  }
  return out;
}
/* -- the run's own provenance (audit finding B3) ---------------------------
 * `run.sh` used to print the image, the probe identity and the generations to
 * stdout and write NOTHING into the artefact directory, and this file took the
 * probe id and the dirty count as command-line arguments. So a directory
 * assembled from two different run.sh invocations — two images, two probe
 * identities, one generation each — could be verdicted as one 48-combination
 * run, and nothing in the artefacts could contradict it.
 *
 * The run now writes `$OUT/provenance.json` before it drives anything, this
 * file reads the probe id and the dirty count OUT OF IT, and every cell must
 * carry its run nonce.
 */
const PROV_PATH = path.join(O.out, "provenance.json");
let PROV = null;
if (fs.existsSync(PROV_PATH)) {
  try { PROV = readJson(PROV_PATH); }
  catch (e) {
    console.error(`${RED}PROVENANCE_UNREADABLE${OFF} ${PROV_PATH}: ${e.message}`);
    process.exit(EXIT_CONTROL);
  }
  // `pgImage` is required for a CERTIFYING verdict and only there: the K2
  // fixture stack writes no provenance at all, and the non-certifying
  // manifests can never print PASS, so nothing is bought by demanding it.
  const need = ["runNonce", "schemas", "probeUserId", "image", "targetDirty"];
  if (CERTIFYING) need.push("pgImage", "pgImagePinned");
  for (const k of need) {
    if (!(k in PROV)) {
      console.error(`${RED}PROVENANCE_MALFORMED${OFF} missing '${k}' in ${PROV_PATH}`);
      process.exit(EXIT_CONTROL);
    }
  }
  if (typeof PROV.runNonce !== "string" || !/^[0-9a-f]{32}$/.test(PROV.runNonce)) {
    console.error(`${RED}PROVENANCE_MALFORMED${OFF} runNonce is not 128 bits of hex`);
    process.exit(EXIT_CONTROL);
  }
} else if (CERTIFYING) {
  console.error(`${RED}PROVENANCE_MISSING${OFF} ${PROV_PATH} does not exist.`);
  console.error("  A certifying verdict must be over ONE run. Without a provenance record an");
  console.error("  artefact directory assembled from two runs — two images, one generation each —");
  console.error("  is indistinguishable from a single 48-combination run, which is how the audit");
  console.error("  obtained the full PASS banner from 24 driven combinations.");
  process.exit(EXIT_CONTROL);
}
// argv still carries these for the non-certifying fixtures; when a provenance
// record exists it is authoritative, and a disagreement is a hard failure
// rather than a silent preference.
if (PROV) {
  if (O.probeUserId && O.probeUserId !== PROV.probeUserId) {
    console.error(`${RED}PROVENANCE_CONTRADICTED${OFF} --probe-user-id ${O.probeUserId} but the run recorded ${PROV.probeUserId}`);
    process.exit(EXIT_CONTROL);
  }
  if (O.targetDirty !== 0 && Number(O.targetDirty) !== Number(PROV.targetDirty)) {
    console.error(`${RED}PROVENANCE_CONTRADICTED${OFF} --target-dirty ${O.targetDirty} but the run recorded ${PROV.targetDirty}`);
    process.exit(EXIT_CONTROL);
  }
  O.probeUserId = PROV.probeUserId;
  O.targetDirty = Number(PROV.targetDirty);
}
if (NEEDS_PROBE && !O.probeUserId) {
  console.error(`${RED}MANIFEST_ENV_UNVERIFIABLE${OFF} the manifest pins __PROBE_USER_ID__ for at least one cell but no probe id is available (neither provenance.json nor --probe-user-id)`);
  console.error("  The freeze-bypass value could not be compared with what the container was running.");
  process.exit(EXIT_HARNESS);
}

// The manifest's claim list and the code's closed schema must be the same set,
// or the manifest is describing a different suite.
{
  const a = [...MANIFEST.claims].sort().join(",");
  const b = [...REQUIRED_CLAIMS].sort().join(",");
  if (a !== b) {
    console.error(`${RED}MANIFEST_CLAIM_SET_DRIFT${OFF}`);
    console.error(`  committed: ${a}`);
    console.error(`  code     : ${b}`);
    process.exit(EXIT_CONTROL);
  }
}

/* -- what "the whole matrix" means, on BOTH axes ---------------------------
 * The claim is about 24 environment combinations on each of two migration
 * generations. Truncating either axis truncates the claim. The cell axis was
 * already folded in here; the schema axis was not, so `--schema 0023` drove
 * half the matrix and still printed `PASS all 24 environment combinations`.
 */
const CELLS_PARTIAL = O.cellsRun !== null && O.cellsTotal !== null && O.cellsRun < O.cellsTotal;

const schemaProblems = [];
if (O.schemas.length === 0) schemaProblems.push("no --schemas were given");
if (new Set(O.schemas).size !== O.schemas.length) schemaProblems.push(`--schemas repeats a generation (${O.schemas.join(",")})`);
if (MANIFEST_SCHEMAS) {
  const unknown = O.schemas.filter((s) => !MANIFEST_SCHEMAS.includes(s));
  if (unknown.length) schemaProblems.push(`--schemas names ${unknown.join(",")}, which the manifest does not list (${MANIFEST_SCHEMAS.join(",")})`);
}
if (schemaProblems.length) {
  console.error(`${RED}SCHEMA_AXIS_MALFORMED${OFF}`);
  for (const p of schemaProblems) console.error(`  - ${p}`);
  process.exit(EXIT_HARNESS);
}
const SCHEMAS_MISSING = MANIFEST_SCHEMAS
  ? MANIFEST_SCHEMAS.filter((s) => !O.schemas.includes(s))
  : [];
const SCHEMA_PARTIAL = SCHEMAS_MISSING.length > 0;

const PARTIAL = CELLS_PARTIAL || SCHEMA_PARTIAL;
// A dirty target checkout, and a fixture manifest, both mean the run is real
// but cannot certify a commit. They are reported by name rather than folded
// into PARTIAL, because they are different facts.
const NON_CERTIFYING_REASONS = [];
if (!CERTIFYING) {
  NON_CERTIFYING_REASONS.push(
    `the manifest ${path.basename(O.manifest)} declares certifying=false (it is a test fixture)`);
}
if (O.targetDirty > 0) {
  NON_CERTIFYING_REASONS.push(
    `the target checkout had ${O.targetDirty} modified path(s): the image cannot be bound to a commit`);
}
/* WHICH DATABASE IMAGE THE RUN ACTUALLY USED (audit finding E).
 *
 * This was decided by `--pg-image-substituted`, and by nothing else. run.sh
 * passes that flag only when it has just run with a substituted image, so
 * every re-verification path — the audit's, the suites', any operator
 * re-running verdict.mjs over an existing artefact directory — omits it BY
 * CONSTRUCTION. `provenance.json` recorded `pgImage` and `pgImagePinned` from
 * the moment B3 introduced it, and this file read neither, so a run on
 * `postgres:17-alpine` re-verdicted to a full certifying PASS.
 *
 * The repair is the same one B3 applied to the probe id and the dirty count:
 * the artefact is authoritative and argv is cross-checked against it. It goes
 * one step further because a boolean the run wrote about itself is not
 * evidence either — pinned-ness is RECOMPUTED here from `provenance.pgImage`
 * against the digest the committed manifest pins, and a provenance record
 * whose own boolean disagrees with that recomputation is a control failure,
 * not a preference. */
let PG_IMAGE_USED = O.pgImageSubstituted || null;
let PG_IMAGE_PINNED = null;
if (CERTIFYING) {
  PG_IMAGE_USED = String(PROV.pgImage);
  PG_IMAGE_PINNED = PG_IMAGE_USED === MANIFEST.pinnedPgImage;
  if (Boolean(PROV.pgImagePinned) !== PG_IMAGE_PINNED) {
    console.error(`${RED}PROVENANCE_CONTRADICTED${OFF} provenance.json says pgImagePinned=${JSON.stringify(PROV.pgImagePinned)} ` +
      `but its own pgImage is ${JSON.stringify(PG_IMAGE_USED)} and the manifest pins ${JSON.stringify(MANIFEST.pinnedPgImage)}`);
    console.error("  A run's boolean about itself is not evidence; the digest is.");
    process.exit(EXIT_CONTROL);
  }
  if (O.pgImageSubstituted && O.pgImageSubstituted !== PG_IMAGE_USED) {
    console.error(`${RED}PROVENANCE_CONTRADICTED${OFF} --pg-image-substituted ${O.pgImageSubstituted} but the run recorded ${PG_IMAGE_USED}`);
    process.exit(EXIT_CONTROL);
  }
  if (!PG_IMAGE_PINNED) {
    NON_CERTIFYING_REASONS.push(
      `the database was ${PG_IMAGE_USED}, not the pinned production digest ${MANIFEST.pinnedPgImage} ` +
      `(read out of provenance.json, not out of argv)`);
  }
} else if (O.pgImageSubstituted) {
  NON_CERTIFYING_REASONS.push(
    `the database was ${O.pgImageSubstituted}, not the pinned production digest`);
}

/* -- the canary reading ---------------------------------------------------- */
let consultedSensor = false;

function loadCanary(schema) {
  if (O.breakSensor === "verdict") return null;   // the property-(C) sabotage
  const file = path.join(O.out, `canary-${schema}.txt`);
  const lines = readLines(file);
  if (lines.length === 0) return null;
  const hits = {};
  const rows = [];
  let armed = null;
  for (const l of lines) {
    let m;
    if ((m = /^NT_CANARY_HIT_([a-z_]+)=(\d+)$/.exec(l))) hits[m[1]] = Number(m[2]);
    else if ((m = /^NT_CANARY_ROW=(.*)$/.exec(l))) {
      const [seq, at, fn, cell, role, sessionUser, addr, argsJson] = m[1].split("|");
      rows.push({ seq: Number(seq), at, fn, cell, role, sessionUser, addr, argsJson });
    } else if ((m = /^NT_CANARY_ARMED_FINAL=(.*)$/.exec(l))) armed = m[1];
  }
  consultedSensor = true;
  return { hits, rows, armed, file };
}

function baselineHits(schema) {
  const file = path.join(O.out, "sql", `commit-before-${schema}.txt`);
  const line = readLines(file).find((l) => l.startsWith("NT_CANARY_HITS="));
  const out = {};
  if (!line) return out;
  for (const part of line.slice("NT_CANARY_HITS=".length).split(",")) {
    const [fn, n] = part.split(":");
    if (fn) out[fn] = Number(n);
  }
  return out;
}

/* WHAT THE TRUSTED SENSOR RUNNER ITSELF WROTE (audit finding F).
 *
 * `--sensor-verdict <schema>=TRUSTWORTHY` was the only statement this file had
 * about whether the canary could be believed, and it is a command-line
 * argument. An audit deleted every trusted-runner artefact from a certified
 * directory — every `sensor-*.txt`, every `sensor-state-*` tree, the ledger, the challenge
 * dumps, the whole record of the detector having been tested at all — asserted
 * `--sensor-verdict 0008=TRUSTWORTHY --sensor-verdict 0023=TRUSTWORTHY`, and
 * got the full certifying PASS. `verdict-scope.json` did not so much as record
 * the sensor verdict, so nothing downstream could notice either.
 *
 * "An absence is only evidence from a detector known to work" was therefore
 * enforced inside run.sh's own process and nowhere else — and run.sh's process
 * is exactly the one a re-verification does not have.
 *
 * The runner's report is now read out of the artefacts, argv is cross-checked
 * against it, and the DERIVED value is the one that decides. The report is a
 * plain file an operator can also rewrite; what it closes is the case where
 * the evidence is simply not there, which is the case that occurred. */
/* ADV-3. THE REPORT MUST BE THE RUNNER'S, NOT SOMETHING TYPED IN ITS PLACE.
 *
 * F's closure — derive the verdict from `sensor-report-<schema>.txt` instead of
 * from `--sensor-verdict` — was defeated by RETYPING that file: delete every
 * trusted-runner artefact, write eight lines of plain text in the documented
 * shape, and the parse below yields TRUSTWORTHY with manifestVerified true.
 * The counter cross-check downstream is real (wrong phase counts ARE refused),
 * so the forger simply typed the right ones.
 *
 * A parse of a plain file says what the file says. What was missing was any
 * reason to believe the file. The runner already draws a 256-bit per-run key
 * at `arm`, seals its manifest with it and MACs every ledger line with it, so
 * the report is now sealed with the same key and this recomputes all three:
 *
 *   the report   mac(runkey, sensor-state-<s>/report-body.txt) == report.hmac,
 *                and the verdict is taken FROM THE SEALED BODY. The plain text
 *                file is then required to agree with it, so the file a human
 *                reads and the bytes that decide cannot differ.
 *   the manifest mac(runkey, manifest.json) == manifest.hmac
 *   the ledger   every line's leading MAC verifies, and the count is the one
 *                the sealed body declares
 *
 * `report.hmac` and `manifest.hmac` are 0600 files in a directory no container
 * mounts. The key is nonetheless in the artefact directory, because a
 * re-verification has to be able to check the seal — see the
 * `sensor-report-authenticity` scope statement for exactly what that does and
 * does not buy.
 */
const hexKeyMac = (keyHex, buf) =>
  crypto.createHmac("sha256", Buffer.from(keyHex, "hex")).update(buf).digest("hex");

/** Equal-length, constant-time hex comparison; false rather than throwing on a
 *  malformed value, because a malformed MAC is a failure, not a crash. */
function macEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")); }
  catch { return false; }
}

/** Verify what the trusted runner sealed with this run's key. */
function sensorSeal(schema) {
  const dir = path.join(O.out, `sensor-state-${schema}`);
  const rel = (p) => path.relative(O.out, p);
  const out = {
    stateDir: rel(dir), sealed: false, sealReason: null, body: null,
    manifestHmacVerified: null, ledgerLines: null, ledgerLinesVerified: null,
  };
  const keyFile = path.join(dir, "runkey");
  if (!fs.existsSync(keyFile)) {
    out.sealReason = `${rel(keyFile)} does not exist, so nothing in ${rel(dir)} can be verified; ` +
                     `the trusted runner draws that key at 'arm' and every seal it writes depends on it`;
    return out;
  }
  const key = fs.readFileSync(keyFile, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(key)) {
    out.sealReason = `${rel(keyFile)} is not 256 bits of hex`;
    return out;
  }
  const bodyFile = path.join(dir, "report-body.txt");
  const macFile = path.join(dir, "report.hmac");
  if (!fs.existsSync(bodyFile) || !fs.existsSync(macFile)) {
    out.sealReason = `${rel(dir)} carries no sealed report ` +
                     `(${!fs.existsSync(bodyFile) ? "report-body.txt" : "report.hmac"} is missing)`;
    return out;
  }
  const bodyBytes = fs.readFileSync(bodyFile);
  const want = fs.readFileSync(macFile, "utf8").trim();
  if (!macEquals(hexKeyMac(key, bodyBytes), want)) {
    out.sealReason = `${rel(bodyFile)} does not verify against ${rel(macFile)} under this run's key: ` +
                     `the report was written or modified by something that did not hold it`;
    return out;
  }
  out.sealed = true;
  out.body = bodyBytes.toString("utf8").split("\n").filter(Boolean);

  // The manifest the runner sealed at `arm`, re-verified here rather than
  // taken from the report's own SENSOR_MANIFEST=verified line.
  const mFile = path.join(dir, "manifest.json");
  const mMac = path.join(dir, "manifest.hmac");
  out.manifestHmacVerified =
    fs.existsSync(mFile) && fs.existsSync(mMac) &&
    macEquals(hexKeyMac(key, fs.readFileSync(mFile)),
              fs.readFileSync(mMac, "utf8").trim());

  // Every challenge the runner recorded, re-verified line by line.
  const ledger = path.join(dir, "ledger.jsonl");
  if (fs.existsSync(ledger)) {
    const lines = readLines(ledger);
    out.ledgerLines = lines.length;
    let ok = 0;
    for (const l of lines) {
      const i = l.indexOf(" ");
      if (i <= 0) continue;
      if (macEquals(hexKeyMac(key, Buffer.from(l.slice(i + 1), "utf8")), l.slice(0, i))) ok++;
    }
    out.ledgerLinesVerified = ok;
  } else {
    out.ledgerLines = 0;
    out.ledgerLinesVerified = 0;
  }
  return out;
}

function sensorReport(schema) {
  const file = path.join(O.out, `sensor-report-${schema}.txt`);
  const rel = path.relative(O.out, file) || `sensor-report-${schema}.txt`;
  const seal = sensorSeal(schema);
  if (!fs.existsSync(file)) {
    return { present: false, rel, verdict: null, seal, reason: `${rel} does not exist` };
  }
  /* THE SEALED BODY DECIDES. The plain text file is read only so that a
   * disagreement between what a human reads and what the verdict uses is
   * itself reportable. When there is no seal there is no derivable verdict:
   * "the file says TRUSTWORTHY" is a statement about a file anyone can type. */
  const textLines = readLines(file);
  if (!seal.sealed) {
    return {
      present: true, rel, verdict: null, seal,
      reason: `${rel} is not sealed by the trusted runner — ${seal.sealReason}. A report that verifies ` +
              `against nothing is eight lines of text, and an auditor obtained a certifying PASS by ` +
              `typing exactly those eight lines`,
    };
  }
  const lines = seal.body;
  const results = lines
    .map((l) => /^SENSOR_RESULT=([A-Z_]+)\|(.*)$/.exec(l))
    .filter(Boolean);
  if (results.length !== 1) {
    return {
      present: true, rel, verdict: null, seal,
      reason: `the sealed report body carries ${results.length} SENSOR_RESULT lines, expected exactly 1`,
    };
  }
  const fields = {};
  for (const part of results[0][2].split("|")) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1);
  }
  const phases = {};
  for (const l of lines) {
    const m = /^SENSOR_PHASE=([a-z]+)\|events=(\d+)$/.exec(l);
    if (m) phases[m[1]] = Number(m[2]);
  }
  const manifestVerified = lines.includes("SENSOR_MANIFEST=verified");
  // Every sealed line must also be in the file an operator reads, or the two
  // copies of the runner's report say different things.
  const textDiffers = lines.filter((l) => !textLines.includes(l));
  return {
    present: true, rel, verdict: results[0][1], fields, phases, manifestVerified, seal,
    textDiffers,
    rounds: Number(fields.rounds),
    // The baseline commitment is taken after `arm` and after the `pre`
    // fidelity probe, so the challenge hits this run caused AFTER it are the
    // interleaved rounds plus the single post-matrix round. That is the same
    // number run.sh declares on --sensor-hits, derived here from the runner's
    // own ledger accounting rather than taken on trust.
    challengeHitsAfterBaseline:
      Number.isFinite(phases.mid) && Number.isFinite(phases.post)
        ? phases.mid + phases.post
        : null,
  };
}

/* ROUND-7 AUDIT (R7-1). ONE PARSE OF THE GATEWAY'S LOG, NOT THREE SILENT ONES.
 *
 * `sinkByCell` and `sinkTruthByCell` each re-read sink-<schema>.jsonl and each
 * carried their own `try { … } catch { continue; }`, exactly as
 * `observers.mjs` `parseJsonl` did — three readers of one file, all three
 * dropping malformed lines without counting them, and `gatewayTimeline`
 * publishing `claimEvidence.gatewayRows` from its own (identically filtered)
 * copy. MEASURED: a `GET /rest/v1/accounts` inserted under a cell's `#idle`
 * tag is refused when well formed and CERTIFIES with one trailing comma
 * added — gatewayRows 555 over a 556-line file.
 *
 * The file is now parsed ONCE, per schema, and the same record is handed to
 * all three readers, so the unparseable set is reported once and the three
 * cannot disagree about what the file contains. */
/* The published list of unparseable lines is bounded so that a wholly
 * corrupted file cannot turn verdict-scope.json into a copy of itself. The
 * COUNT is never truncated — `claimEvidence.linesUnparseable` is exact — and
 * the count, not the list, is what the refusal rests on. */
const UNPARSEABLE_DETAIL_CAP = 50;
function noteUnparseable(obsStats, rel, u) {
  if (obsStats.linesUnparseableDetail.length < UNPARSEABLE_DETAIL_CAP) {
    obsStats.linesUnparseableDetail.push({
      file: rel, lineNo: u.lineNo, bytes: u.bytes, error: u.error,
    });
  }
}

const gatewayFileCache = new Map();
function gatewayFile(schema) {
  if (!gatewayFileCache.has(schema)) {
    gatewayFileCache.set(schema, parseJsonlFile(path.join(O.out, `sink-${schema}.jsonl`)));
  }
  return gatewayFileCache.get(schema);
}

function sinkByCell(schema) {
  const map = new Map();
  for (const e of gatewayFile(schema).rows) {
    if (!map.has(e.cell)) map.set(e.cell, []);
    map.get(e.cell).push(e);
  }
  return map;
}

/** What the RECORDING GATEWAY's own log says, per cell prefix: which cells it
 *  actually served, and which generation fingerprint it read out of the
 *  database while serving them. Written by a different container than the one
 *  that writes the cell result — which is the entire reason it is consulted. */
function sinkTruthByCell(schema) {
  const drivenTags = new Set();
  const drivenCells = new Set();
  const witnesses = new Map();   // cell id -> Set(fingerprint)
  for (const e of gatewayFile(schema).rows) {
    const tag = typeof e.cell === "string" ? e.cell : "";
    if (!tag || tag === "(unset)") continue;
    drivenTags.add(tag);
    const id = tag.split("#")[0];
    drivenCells.add(id);
    if (e.witness && typeof e.witness.fingerprint === "string") {
      if (!witnesses.has(id)) witnesses.set(id, new Set());
      witnesses.get(id).add(e.witness.fingerprint);
    }
  }
  return { drivenTags, drivenCells, witnesses };
}

/** Did the IMAGE UNDER TEST actually boot for THIS cell, and are the events
 *  this result claims the ones THAT container emitted?
 *
 *  `$OUT/instr/<schema>-<cell>.jsonl` is a host bind mount appended to by the
 *  process under test, in a third container, once per real container start.
 *  Existence alone only catches a cell that never ran. The load-bearing part is
 *  the last check: every boot event the cell result reports must be present in
 *  THIS cell's instrument log, matched on `seq`+`t`+`kind`. A result copied from
 *  another cell of the same genuine run — where the file, the sink log and the
 *  cell tags all legitimately exist — carries the OTHER container's boot events,
 *  and they are not in this file. Measured on a real 48-cell set: 14 of 14 for
 *  the right cell, 0 of 14 for any other. */
function instrumentEvidence(schema, cellId, cell) {
  const f = path.join(O.out, "instr", `${schema}-${cellId}.jsonl`);
  const rel = path.relative(O.out, f);
  if (!fs.existsSync(f)) return { ok: false, reason: `no ${rel}` };
  let text = "";
  try { text = fs.readFileSync(f, "utf8"); }
  catch (e) { return { ok: false, reason: `${rel} unreadable: ${e.message}` }; }
  if (!text.includes('"kind":"instrument.loaded"')) {
    return { ok: false, reason: `${rel} carries no instrument.loaded event (${text.length} bytes)` };
  }
  const boot = Array.isArray(cell.bootEvents) ? cell.bootEvents : null;
  if (!boot || boot.length === 0) {
    // An empty list would make the comparison below vacuously true, so it is a
    // failure rather than a pass.
    return { ok: false, reason: `the result reports no boot events, so it cannot be tied to ${rel}` };
  }
  const missing = boot.filter((e) =>
    !text.includes(`"seq":${e.seq},"t":${e.t},"kind":"${e.kind}"`));
  if (missing.length) {
    return {
      ok: false,
      reason: `${missing.length} of ${boot.length} boot events in this result are absent from ${rel} ` +
              `(first: seq=${missing[0].seq} kind=${missing[0].kind}) — these events were emitted by a ` +
              `different container than the one this cell started`,
    };
  }
  return { ok: true };
}

function pgLogHitsByCell(schema) {
  const map = new Map();
  for (const line of readLines(path.join(O.out, `pglog-hits-${schema}.txt`))) {
    const m = /NT_CANARY_HIT fn=(\S+) n=(\d+) cell=(\S+)/.exec(line);
    if (!m) continue;
    if (!map.has(m[3])) map.set(m[3], []);
    map.get(m[3]).push({ fn: m[1], n: Number(m[2]) });
  }
  return map;
}

/* -- run ------------------------------------------------------------------- */

let exitCode = 0;
const summary = [];
// Collected across generations so the two axes can be compared with each other
// and not only with the manifest: the observed generation fingerprints must
// DIFFER, and there must be exactly one run nonce in the whole verdict.
const observedWitnesses = new Map();   // schema -> Set(fingerprint)
const observedRunNonces = new Set();
// schema -> what the trusted runner's own artefacts say, beside what argv said
const sensorEvidence = new Map();
// schema -> how the in-process claims were decided, and what the two copies of
// the instrument's reading disagreed about
const observerEvidence = new Map();
const instrumentLogCache = new Map();
/* PER-CLAIM STATUS TALLY, written to verdict-scope.json.
 *
 * The transcript prints only the claims that FAILED, because a per-request dump
 * of sixteen satisfied claims over 480 requests is unreadable. That made
 * "claim X was satisfied" unobservable from the outside, and the K2
 * discrimination control for `refusalIdentity` — which must show
 * `expectedResponseClass` STILL satisfied while `refusalIdentity` goes violated
 * — could only ever read the absence of a string. An assertion that a string is
 * absent from output that never contains it is vacuous, which is the same
 * defect as the coloured-banner grep. So the tally is emitted as data. */
const claimTally = new Map();          // claim -> {satisfied, violated, indeterminate}
function tally(records) {
  for (const r of records) {
    if (!r || typeof r.claim !== "string") continue;
    if (!claimTally.has(r.claim)) claimTally.set(r.claim, { satisfied: 0, violated: 0, indeterminate: 0 });
    const t = claimTally.get(r.claim);
    if (r.status === "satisfied") t.satisfied++;
    else if (r.status === "violated") t.violated++;
    else t.indeterminate++;
  }
}

for (const schema of O.schemas) {
  const canary = loadCanary(schema);
  const base = baselineHits(schema);
  const sinkMap = sinkByCell(schema);
  const sinkTruth = sinkTruthByCell(schema);
  const pgMap = pgLogHitsByCell(schema);
  observedWitnesses.set(schema, new Set());

  /* --- F. the sensor verdict, DERIVED, then cross-checked against argv --- */
  const declaredSensorVerdict = O.sensorVerdicts[schema] || null;
  const report = sensorReport(schema);
  if (!report.verdict) {
    // No derivable verdict. For a certifying manifest that is the whole of
    // finding F and must stop the run; for a fixture it is expected, because
    // the K2 stack runs no trusted sensor runner at all.
    if (CERTIFYING) {
      hard(`schema ${schema}: no trusted-runner sensor report in the artefacts (${report.reason}); ` +
           `--sensor-verdict ${declaredSensorVerdict || "(none)"} is an assertion on the command line, and an ` +
           `absence is only evidence from a detector KNOWN to work`);
    }
  } else if (declaredSensorVerdict && declaredSensorVerdict !== report.verdict) {
    hard(`schema ${schema}: --sensor-verdict says ${declaredSensorVerdict} but the report the trusted runner ` +
         `SEALED for ${schema} records SENSOR_RESULT=${report.verdict} (${report.rel})`);
  }
  if (report.verdict && CERTIFYING && !report.manifestVerified) {
    hard(`schema ${schema}: the sealed report body does not record SENSOR_MANIFEST=verified; ` +
         `the runner did not confirm the sensor objects were the ones it installed`);
  }
  /* ADV-3. What the runner sealed, re-verified here against its own key rather
   * than believed because the file says so. */
  if (CERTIFYING && report.verdict) {
    if (report.textDiffers && report.textDiffers.length) {
      hard(`schema ${schema}: ${report.textDiffers.length} line(s) of the SEALED sensor report are absent from ` +
           `${report.rel} (first: ${JSON.stringify(report.textDiffers[0])}); the file an operator reads and the ` +
           `bytes this verdict derives the sensor verdict from are not the same report`);
    }
    if (report.seal.manifestHmacVerified !== true) {
      hard(`schema ${schema}: ${report.seal.stateDir}/manifest.json does not verify against manifest.hmac under ` +
           `this run's key; the sealed run manifest — which pins the wrappers, the nonce and the expected sensor ` +
           `definition — is not the one the runner sealed`);
    }
    const declaredLedger = Number(
      (report.seal.body.map((l) => /^SENSOR_LEDGER=lines=(\d+)$/.exec(l)).filter(Boolean)[0] || [])[1]);
    if (!Number.isFinite(declaredLedger)) {
      hard(`schema ${schema}: the sealed report body declares no SENSOR_LEDGER=lines=<n>, so the number of ` +
           `challenges behind this verdict cannot be checked against the ledger`);
    } else if (report.seal.ledgerLines !== declaredLedger) {
      hard(`schema ${schema}: the sealed report declares ${declaredLedger} challenge ledger line(s) but ` +
           `${report.seal.stateDir}/ledger.jsonl holds ${report.seal.ledgerLines}`);
    }
    if (report.seal.ledgerLines !== report.seal.ledgerLinesVerified) {
      hard(`schema ${schema}: ${report.seal.ledgerLines - report.seal.ledgerLinesVerified} of ` +
           `${report.seal.ledgerLines} challenge ledger line(s) in ${report.seal.stateDir} do not verify against ` +
           `this run's key; the record of the detector having been challenged is not the runner's`);
    }
    if (report.seal.ledgerLines === 0) {
      hard(`schema ${schema}: the trusted runner's challenge ledger in ${report.seal.stateDir} is empty; ` +
           `a sensor that was never challenged has not been shown to work, and its silence is not evidence`);
    }
  }
  // The derived value decides. argv is kept only for the fixture stacks, which
  // have no runner and can never print PASS.
  const sensorVerdict = report.verdict || (CERTIFYING ? null : declaredSensorVerdict);
  sensorEvidence.set(schema, {
    declared: declaredSensorVerdict,
    derived: report.verdict,
    derivedFrom: report.present ? report.rel : null,
    effective: sensorVerdict,
    rounds: report.rounds === undefined ? null : report.rounds,
    manifestVerified: report.manifestVerified === undefined ? null : report.manifestVerified,
    /* ADV-3: whether the report was the trusted runner's, and what else of
     * the runner's own state re-verified under the same key. */
    sealed: report.seal ? report.seal.sealed : null,
    sealReason: report.seal ? report.seal.sealReason : null,
    sealedBodyAgreesWithText: report.textDiffers ? report.textDiffers.length === 0 : null,
    manifestHmacVerified: report.seal ? report.seal.manifestHmacVerified : null,
    ledgerLines: report.seal ? report.seal.ledgerLines : null,
    ledgerLinesVerified: report.seal ? report.seal.ledgerLinesVerified : null,
  });

  /* --- D. THE OBSERVERS' OWN FILES, as the source of the in-process claims -
   * `gatewayTimeline` gives the request windows from sink-<schema>.jsonl —
   * boundaries the driver did not write — and `instrumentLog` gives the events
   * the IMAGE UNDER TEST appended to its own bind mount. Everything the claims
   * called "the instrument said" used to be the driver's transcription of
   * those events; it is now the events. See observers.mjs. */
  const gw = CERTIFYING ? gatewayTimeline(O.out, schema, gatewayFile(schema)) : null;
  const obsStats = {
    derivedFrom: gw ? "observer files" : "the driver's transcription (non-certifying manifest)",
    windows: 0, windowsMissing: 0, windowsUnbounded: 0,
    observerEvents: 0, transcribedEvents: 0,
    eventsOnlyInObserverLog: 0, eventsOnlyInTranscription: 0,
    attestationsMatched: 0, attestationsMissing: 0, attestationsMismatched: 0,
    timingOutsideWindow: 0,
    /* ADV-1. The complement of `observerEvents`: every line of every
     * instrument log, sorted into what accounts for it. `eventsUnattributed`
     * is the count an auditor drove to three, outside every window, and got a
     * PASS. See observers.mjs `attributeEvents`. */
    logEvents: 0, eventsAttributedToBoot: 0, eventsAttributedToWindow: 0,
    eventsInMoreThanOneWindow: 0, eventsUnattributed: 0,
    instrumentLogsWithoutAResult: 0,
    /* ROUND-7 AUDIT (R7-1). THE DENOMINATOR, PUBLISHED.
     * `logEvents` and `gatewayRows` were both counted from the PARSED set,
     * after `parseJsonl` had silently dropped every line that did not parse,
     * so they could not disagree with themselves and no reader could tell how
     * much of the file they covered. `rawLines` and `gatewayRawLines` are the
     * non-empty line counts of the same files — the numbers `grep -c .`
     * prints — so the artefact now carries a denominator a reader can check
     * by hand. `linesUnparseable` is the difference, over BOTH observers, and
     * any non-zero value is a hard failure naming the file and the line.
     * MEASURED before the fix: one trailing comma on a planted broker event
     * took rc=3/"1 UNATTRIBUTED" to rc=0/PASS with logEvents 298 over 299
     * lines; replacing the line's final "}" with a SPACE did the same at
     * identical byte and line counts. */
    rawLines: 0, gatewayRawLines: 0,
    linesUnparseable: 0, instrLinesUnparseable: 0, gatewayLinesUnparseable: 0,
    linesUnparseableDetail: [],
    /* ROUND-7 AUDIT (R7-2). `eventIdentity` covers seq/t/kind/detail and
     * excludes `stack` deliberately — but nothing refused an UNKNOWN top-level
     * key, so the real exclusion was "everything that is not one of four
     * fields". MEASURED: a `brokerCall` object appended to an existing boot
     * line certified with every published count unchanged. The permitted set
     * is now an allow-list over what instrument.cjs actually writes. */
    eventsWithForeignKeys: 0, foreignKeyDetail: [],
    // Attributed-to-boot is an accounting statement, not an absolution: the
    // bucket is published by kind, and every kind that is not one a boot
    // snapshot may contain is counted and refused (round-5 audit — this was a
    // deny-list of four network kinds reading a self-reported host class, and
    // two different shapes walked through it to a certifying PASS).
    bootEventKinds: {}, bootEventsRefused: 0,
    /* ROUND-5 AUDIT. The same complement question, asked of the GATEWAY's log.
     * Entries under #witness / #idle / (unset) were bucketed by sinkByCell and
     * read by nothing; a GET /rest/v1/accounts planted under one cell's #idle
     * tag certified. */
    gatewayRows: 0, gatewayHarnessRows: 0, gatewayRowsInAClaimedRequest: 0,
    gatewayRowsUnaccounted: 0, gatewayRowsMislabelled: 0,
    /* ROUND-8 AUDIT (R8-1/R8-2). Which SURFACE each gateway row was on, derived
     * from its path, and how many rows carried no `kind` at all. Both are
     * published because the round-8 attack was a row whose self-description was
     * removed (rc=0 PASS with the derivation already computed and printed) and
     * a row on a surface nobody had enumerated. */
    gatewayRowsByClass: {}, gatewayRowsWithoutADeclaredKind: 0,
    /* ROUND-9 AUDIT. The harness's own control traffic, ACCOUNTED rather than
     * skipped. `harness` is the one class no claim reads, and the /__canary
     * control plane it names is served to anything that can open a socket to
     * the gateway — which the image under test can, by construction. A real
     * GET /__canary/health row, produced by a container that was not the
     * driver and spliced into a claimed request window, used to certify. */
    gatewayHarnessAccounted: 0, gatewayHarnessUnaccounted: 0, gatewayHarnessByShape: {},
    /* And the same question of the IMAGE's own egress records: a declared
     * detail.pathClass that its own URL contradicts. */
    imageEgressPathClassContradictions: 0,
    // v2 of the request attestation covers each event's `detail`; v1 did not.
    observationVersionsSeen: [],
  };
  observerEvidence.set(schema, obsStats);
  /* R7-1. THE GATEWAY'S LOG, LINE BY LINE, INCLUDING THE LINES THAT DID NOT
   * PARSE. This runs whether or not the manifest is certifying, because a
   * malformed line in an observer's log is a defect in either case, and
   * `sinkByCell`/`sinkTruthByCell` read this file on both paths. */
  {
    const gwFile = gatewayFile(schema);
    obsStats.gatewayRawLines = gwFile.rawLines;
    obsStats.gatewayLinesUnparseable = gwFile.unparseable.length;
    obsStats.linesUnparseable += gwFile.unparseable.length;
    const rel = `sink-${schema}.jsonl`;
    for (const u of gwFile.unparseable) noteUnparseable(obsStats, rel, u);
    for (const u of gwFile.unparseable.slice(0, 3)) {
      hard(`schema ${schema}: ${describeUnparseable(rel, u)} — a line of the RECORDING GATEWAY'S OWN LOG ` +
           `that does not parse. It used to be dropped in silence by three separate readers, so ` +
           `claimEvidence.gatewayRows counted the file MINUS this line and nothing could notice: measured, a ` +
           `GET /rest/v1/accounts under a cell's #idle tag is refused when well formed and CERTIFIES with one ` +
           `trailing comma added. An unparseable line is not an absent one — it is a line whose contents this ` +
           `verdict cannot read, and this run drove ${gwFile.rawLines} non-empty lines into that file ` +
           `(check with: grep -c . ${rel}).`);
    }
    if (gwFile.unparseable.length > 3) {
      hard(`schema ${schema}: …and ${gwFile.unparseable.length - 3} further unparseable line(s) in ${rel} ` +
           `(the first three are named above; claimEvidence.linesUnparseableDetail carries up to ` +
           `${UNPARSEABLE_DETAIL_CAP} of them)`);
    }
  }
  if (gw) {
    if (!gw.present) {
      hard(`schema ${schema}: sink-${schema}.jsonl does not exist, so there is no observer-defined request ` +
           `window and every in-process claim would fall back to the driver's own account of itself`);
    }
    if (gw.repeatedTags.length) {
      hard(`schema ${schema}: the recording gateway logged ${gw.repeatedTags.length} cell tag(s) in more than one ` +
           `separate window (${gw.repeatedTags.slice(0, 4).join(", ")}); a request window must be bounded by its own terminator`);
    }
  }

  const cellFiles = fs.readdirSync(path.join(O.out, "cells"))
    .filter((f) => f.startsWith(`result-${schema}-`) && f.endsWith(".json"))
    .sort();

  console.log(`\n${BOLD}### SCHEMA ${schema} — ${cellFiles.length} environment combinations${OFF}`);
  console.log(`    claims required per request (${REQUIRED_CLAIMS.length}): ${REQUIRED_CLAIMS.join(", ")}`);

  // --- 1. CARDINALITY, against the committed manifest -----------------------
  const expectedCells = O.cellsRun !== null ? O.cellsRun : MANIFEST.cells;
  if (cellFiles.length !== expectedCells) {
    hard(`schema ${schema}: ${cellFiles.length} cell result files, the manifest requires ${expectedCells}`);
  }
  const endpointKey = (r) => `${r.method} ${r.template} auth=${r.authenticated}`;
  const wantEndpoints = [...MANIFEST.endpoints].sort();

  // --- 1b. IDENTITY. Which combinations, not how many files. ----------------
  // Collected here, judged after the per-cell loop so every cell contributes.
  const drivenIds = [];
  // Every `<cell>#<n>` some cell result of this generation claims. The gateway
  // may log a non-harness entry under one of these and nowhere else.
  const claimedRequestTags = new Set();

  let totalRequests = 0;
  let totalViolating = 0;
  let totalIndeterminate = 0;
  let cellsWithFindings = 0;
  const allRows = [];

  for (const f of cellFiles) {
    let cell;
    try { cell = readJson(path.join(O.out, "cells", f)); }
    catch (e) { hard(`schema ${schema}: cell file ${f} is unreadable: ${e.message}`); continue; }

    if (!Array.isArray(cell.results)) {
      hard(`schema ${schema}/${f}: no results array — the cell was not executed`);
      continue;
    }

    /* R7-2, THE SAME QUESTION ASKED OF THE OTHER COPY. The transcription is
     * compared with the image's own log on `eventIdentity`, so a top-level key
     * the identity does not cover is invisible on this side too. Both copies
     * are checked, because a check applied to one of two copies is a check the
     * other copy walks past. */
    {
      const groups = [["bootEvents", Array.isArray(cell.bootEvents) ? cell.bootEvents : []]];
      for (let ri = 0; ri < cell.results.length; ri++) {
        const r = cell.results[ri];
        groups.push([`results[${ri}].events`, Array.isArray(r && r.events) ? r.events : []]);
      }
      let n = 0;
      for (const [where, evs] of groups) {
        for (let i = 0; i < evs.length; i++) {
          const keys = eventForeignKeys(evs[i]);
          if (!keys.length) continue;
          n++;
          obsStats.eventsWithForeignKeys++;
          if (obsStats.foreignKeyDetail.length < UNPARSEABLE_DETAIL_CAP) {
            obsStats.foreignKeyDetail.push({ file: `cells/${f}`, event: `${where}[${i}]`, keys });
          }
          if (n <= 3) {
            hard(`schema ${schema}/${f}: ${where}[${i}] carries top-level key(s) ` +
                 `${keys.map((k) => JSON.stringify(k)).join(", ")}, which instrument.cjs does not write and ` +
                 `the attested event identity does not cover (permitted: ${EVENT_TOP_LEVEL_KEYS.join(", ")}). ` +
                 `The driver's transcription is compared with the image's own log on that identity, so an ` +
                 `unrecognised key is bound by nothing on either side.`);
          }
        }
      }
      if (n > 3) {
        hard(`schema ${schema}/${f}: …and ${n - 3} further transcribed event(s) carrying an unrecognised ` +
             `top-level key`);
      }
    }

    /* ---- the three independent statements of this cell's identity ---------
     * (a) the filename, (b) the driver's own `cell` field, (c) the freeze
     * variables the instrument read back out of the running container. A copy
     * of one cell under twenty-four names disagrees with itself at (a) vs (b),
     * and — the check that cannot be satisfied by renaming — at (c).
     */
    const fileId = f.slice(`result-${schema}-`.length, -".json".length);
    const cellId = typeof cell.cell === "string" ? cell.cell : null;
    if (!cellId) {
      hard(`schema ${schema}/${f}: the result file states no cell identity`);
      continue;
    }
    drivenIds.push(cellId);
    if (cellId !== fileId) {
      hard(`schema ${schema}/${f}: the file is named for '${fileId}' but the driver recorded cell '${cellId}' — ` +
           `a cell result was copied or renamed`);
    }
    if (CELL_ID_PATTERN && !CELL_ID_PATTERN.test(cellId)) {
      hard(`schema ${schema}/${cellId}: this manifest only admits cell ids matching ${MANIFEST.cellIdPattern}`);
    }
    for (const r of cell.results) {
      if (typeof r.cellTag !== "string" || !r.cellTag.startsWith(`${cellId}#`)) {
        hard(`schema ${schema}/${cellId}/${r.id}: cellTag ${JSON.stringify(r.cellTag)} does not belong to this cell`);
        break;
      }
      /* ADV-1. …and it must be a REQUEST tag. `<cell>#witness` and
       * `<cell>#idle` are the driver's own bookends; the gateway logs them and
       * therefore has a "window" for them, and the `#idle` one is the ~15 s
       * hole between two containers that the ADV-1 attack lived in. A result
       * that named one of them as its tag would launder events out of that
       * hole into a request. */
      if (!REQUEST_TAG.test(r.cellTag)) {
        hard(`schema ${schema}/${cellId}/${r.id}: cellTag ${JSON.stringify(r.cellTag)} is not a request tag ` +
             `(<cell>#<n>); #witness and #idle are window BOUNDARIES and can never be a request's window`);
        break;
      }
      claimedRequestTags.add(r.cellTag);
    }

    // (c) WHAT THE CONTAINER WAS ACTUALLY RUNNING.
    if (CELL_IDS) {
      if (!CELL_IDS.includes(cellId)) {
        hard(`schema ${schema}/${cellId}: the manifest pins no such environment combination`);
      } else {
        const want = expectedRawEnv(cellId);
        const got = cell.instrumentEnv && cell.instrumentEnv.raw_freeze_flags;
        if (!got || typeof got !== "object") {
          hard(`schema ${schema}/${cellId}: the instrument reported no raw_freeze_flags ` +
               `(${cell.instrumentEnv && cell.instrumentEnv.error ? cell.instrumentEnv.error : "field absent"}) — ` +
               `this run cannot say which environment the container was running`);
        } else {
          const diffs = [];
          for (const k of Object.keys(want)) {
            const w = want[k];
            const g = Object.prototype.hasOwnProperty.call(got, k) ? got[k] : undefined;
            if (g !== w) {
              diffs.push(`${k}: running ${JSON.stringify(g === undefined ? null : g)}, the manifest pins ${JSON.stringify(w)}`);
            }
          }
          if (diffs.length) {
            hard(`schema ${schema}/${cellId}: the container was NOT running this cell's environment — ${diffs.join("; ")}`);
          }
        }
        // The plan the driver was handed must also be this cell's plan. Cheap,
        // and it catches a cell driven with the right env under the wrong name.
        const planEnv = cell.env && typeof cell.env === "object" ? cell.env : null;
        if (!planEnv) {
          hard(`schema ${schema}/${cellId}: the result file records no plan environment`);
        }
      }
    }

    /* ---- (d)(e)(f)(g) WHICH GENERATION, AND WHICH RUN --------------------
     * Everything above is generation-independent, which is exactly how one
     * generation's twenty-four files under the other generation's names
     * produced a 48-combination PASS. These four checks are the closure, and
     * three of the four read a file this driver did not write.
     *
     * They are required for a CERTIFYING manifest. The K2 fixture manifest
     * drives synthetic cells through a stack that has no provenance record and
     * names its instrument logs differently; it is `certifying: false` and can
     * never print PASS, so it is exempted here by name rather than by accident.
     */
    if (CERTIFYING) {
      // (d1) the driver's own statement of the generation.
      if (typeof cell.schema !== "string" || cell.schema.length === 0) {
        hard(`schema ${schema}/${cellId}: the result file states no migration generation — ` +
             `the only generation marker would be the filename this verdict supplied itself`);
      } else if (cell.schema !== schema) {
        hard(`schema ${schema}/${cellId}: the file is filed under generation '${schema}' but the driver ` +
             `recorded generation '${cell.schema}' — a cell result was copied across generations`);
      }

      // (g) one run.
      if (typeof cell.runNonce !== "string" || !/^[0-9a-f]{32}$/.test(cell.runNonce)) {
        hard(`schema ${schema}/${cellId}: the result file carries no run nonce; ` +
             `cells from two different runs cannot be told apart`);
      } else {
        observedRunNonces.add(cell.runNonce);
        if (PROV && cell.runNonce !== PROV.runNonce) {
          hard(`schema ${schema}/${cellId}: run nonce ${cell.runNonce} but provenance.json records ` +
               `${PROV.runNonce} — this cell was produced by a different run`);
        }
      }

      // (d2) THE LOAD-BEARING ONE: what the gateway read out of the running
      // database while this cell was being driven, against what this checkout
      // pins for the generation the filename claims.
      const wantFp = MANIFEST.schemaWitness[schema] && MANIFEST.schemaWitness[schema].fingerprint;
      const w = cell.dbWitness;
      if (!w || typeof w.fingerprint !== "string") {
        hard(`schema ${schema}/${cellId}: no database generation witness in the result ` +
             `(${(w && w.error) || "field absent"}) — this run cannot say which migration generation was driven`);
      } else {
        observedWitnesses.get(schema).add(w.fingerprint);
        if (w.fingerprint !== wantFp) {
          const otherGen = MANIFEST_SCHEMAS.find(
            (s) => MANIFEST.schemaWitness[s].fingerprint === w.fingerprint);
          hard(`schema ${schema}/${cellId}: the database this cell was driven against is NOT generation ` +
               `${schema} — the gateway read fingerprint ${w.fingerprint}` +
               (otherGen ? ` (which is generation ${otherGen})` : "") +
               `, this checkout pins ${wantFp} for ${schema}` +
               (w.facts ? ` [observed: ${w.facts.routines} public routines, ${w.facts.relation_columns} relation columns]` : ""));
        }
        // (e) and the gateway's OWN log must say the same thing for this cell.
        const sinkFps = sinkTruth.witnesses.get(cellId);
        if (!sinkFps || sinkFps.size === 0) {
          hard(`schema ${schema}/${cellId}: the recording gateway's log records no generation witness for this cell; ` +
               `the only copy of it is in the file the driver wrote`);
        } else if (!sinkFps.has(w.fingerprint)) {
          hard(`schema ${schema}/${cellId}: the result claims fingerprint ${w.fingerprint} but the gateway logged ` +
               `${[...sinkFps].join(",")} for this cell`);
        }
      }

      // (e2) a cell nobody drove is not in the gateway's log at all.
      const missingTags = cell.results
        .map((r) => r.cellTag)
        .filter((t) => typeof t === "string" && !sinkTruth.drivenTags.has(t));
      if (missingTags.length) {
        hard(`schema ${schema}/${cellId}: ${missingTags.length} of ${cell.results.length} request tags never reached ` +
             `the recording gateway (${missingTags.slice(0, 3).join(", ")}${missingTags.length > 3 ? ", …" : ""}) — ` +
             `sink-${schema}.jsonl is written by a different container and lists only the cells actually driven`);
      }

      // (f) and the image under test really booted FOR THIS CELL, and these are
      // that container's events.
      const booted = instrumentEvidence(schema, cellId, cell);
      if (!booted.ok) {
        hard(`schema ${schema}/${cellId}: this result is not the one the image under test produced for this cell — ${booted.reason}`);
      }
    }
    if (cell.results.length !== MANIFEST.requestsPerCell) {
      hard(`schema ${schema}/${cell.cell}: ${cell.results.length} requests, the manifest requires ${MANIFEST.requestsPerCell}`);
    }
    const gotEndpoints = cell.results.map(endpointKey).sort();
    if (JSON.stringify(gotEndpoints) !== JSON.stringify(wantEndpoints)) {
      const missing = wantEndpoints.filter((e) => !gotEndpoints.includes(e));
      const extra = gotEndpoints.filter((e) => !wantEndpoints.includes(e));
      hard(`schema ${schema}/${cell.cell}: endpoint set differs from the manifest` +
        (missing.length ? ` (missing: ${missing.join("; ")})` : "") +
        (extra.length ? ` (unexpected: ${extra.join("; ")})` : ""));
    }

    let cellHasFinding = false;
    for (const r of cell.results) {
      totalRequests++;
      const tag = r.cellTag;
      /* THE EXEMPTION IS DERIVED HERE TOO (round-8 audit). This filter used to
       * read `e.kind !== "harness"`, so which rows a request's claims could
       * even see depended on the label the row gave itself. It is the path
       * that decides, in one place, for both this filter and every bucket in
       * claims.mjs. */
      const sinkEntries = (sinkMap.get(tag) || [])
        .filter((e) => classifyGatewayPath(e && e.path) !== "harness");
      const pgHits = pgMap.get(tag) || [];
      const canaryRows = canary ? canary.rows.filter((row) => row.cell === tag) : [];

      /* ---- D. WHAT THE IMAGE'S OWN LOG SAYS HAPPENED IN THIS WINDOW -------
       * `r.events` is the DRIVER's transcription of the instrument's reading.
       * The instrument's own file is the reading. Both are consulted: the
       * claims are decided from the observer's copy, and any disagreement
       * between the two is a hard failure in its own right, because a run in
       * which the two copies of one measurement differ has not measured
       * anything.
       *
       * Re-measured over the four distinct genuine certifying runs still on
       * this machine: 1920 windows, 2385 log events, 0 diffs — but every one
       * of those 2385 is a BOOT event, so the in-window comparison is vacuous
       * on a frozen set. It is exercised by k14's D1, which plants two events
       * at a window midpoint and asserts they are selected. (The superseded
       * "720 windows / 2179 events" figure mixed whole-matrix and
       * single-generation runs; see observers.mjs.) */
      let claimEvents = r.events || [];
      let observerSensors = null;
      if (gw) {
        const win = gw.windows.get(tag);
        obsStats.windows++;
        obsStats.transcribedEvents += Array.isArray(r.events) ? r.events.length : 0;
        const ilog = instrumentLog(O.out, schema, cellId, instrumentLogCache);
        if (!win) {
          obsStats.windowsMissing++;
          hard(`${schema}/${cellId}/${r.id}: the recording gateway logged no window for tag ${tag}, so this ` +
               `request's in-process claims could only be decided from the driver's own account of itself`);
        } else if (!win.bounded) {
          obsStats.windowsUnbounded++;
          hard(`${schema}/${cellId}/${r.id}: the gateway's window for ${tag} has no terminator — the driver's ` +
               `closing #idle mark is missing, so the window would run to the end of the log`);
        } else {
          const obsEv = eventsInWindow(ilog.events, win);
          obsStats.observerEvents += obsEv.length;
          const d = diffEventSets(obsEv, r.events || []);
          if (d.onlyObserver.length) {
            obsStats.eventsOnlyInObserverLog += d.onlyObserver.length;
            hard(`${schema}/${cellId}/${r.id}: the IMAGE'S OWN LOG (${ilog.rel}) records ${d.onlyObserver.length} ` +
                 `event(s) in this request's window that the cell result does not report ` +
                 `[${d.onlyObserver.slice(0, 3).map(describeEvent).join("; ")}] — the driver's transcription and ` +
                 `the observer disagree about what the process under test did`);
          }
          if (d.onlyDriver.length) {
            obsStats.eventsOnlyInTranscription += d.onlyDriver.length;
            hard(`${schema}/${cellId}/${r.id}: the cell result reports ${d.onlyDriver.length} event(s) that are ` +
                 `absent from the image's own log ${ilog.rel} ` +
                 `[${d.onlyDriver.slice(0, 3).map(describeEvent).join("; ")}]`);
          }
          claimEvents = obsEv;
        }
        // The instrument's liveness is now stated by the instrument's file, not
        // by the driver's report of it. A claim decided from an observer that
        // is not there must be INDETERMINATE, and this is the only copy of
        // "was it there" that the process under test cannot edit for us.
        if (!ilog.present || !ilog.loaded) {
          observerSensors = {
            instrument: {
              live: false,
              reason: !ilog.present
                ? `the image's own log ${ilog.rel} does not exist`
                : `${ilog.rel} carries no instrument.loaded event`,
            },
          };
        }

        /* ---- B and C. THE GATEWAY'S OWN COPY OF THIS OBSERVATION ---------
         * The cell result used to be the only record of what a request
         * observed, which is what let one generation's results be filed as the
         * other's and one cell's results be pasted into twenty-three more. The
         * driver now attests each request to the gateway as it finishes; this
         * recomputes the attestation from the cell result and requires the
         * gateway's independently written copy to be the same. */
        const want = observationFields(PROV ? PROV.runNonce : "", schema, cellId, r);
        const wantDigest = observationDigest(want);
        const logged = (gw.observations.get(tag) || []);
        if (logged.length === 0) {
          obsStats.attestationsMissing++;
          hard(`${schema}/${cellId}/${r.id}: the recording gateway logged no observation for ${tag}. The cell ` +
               `result is then the ONLY record of what this request observed, which is exactly what let one ` +
               `generation's results be certified as the other's`);
        } else if (logged.length > 1) {
          obsStats.attestationsMismatched++;
          hard(`${schema}/${cellId}/${r.id}: the gateway logged ${logged.length} observations for ${tag}; ` +
               `one request is attested once`);
        } else {
          const got = logged[0];
          /* ROUND-5 AUDIT. Say plainly WHICH attestation this is. v1 hashed
           * `[seq, t, kind]` per event and left `detail` — the host, the port,
           * the path class — bound by nothing; rewriting only the detail in
           * both instrument-side copies turned a measured
           * `noBrokerCall=violated` into a certifying PASS. v2 hashes the
           * detail too. A v1 directory therefore cannot certify, and it must
           * say so in those words rather than as an unexplained digest
           * mismatch on all 480 requests. */
          const gotV = Number(got.v);
          if (Number.isFinite(gotV) && gotV !== OBSERVATION_VERSION) {
            if (!obsStats.observationVersionsSeen.includes(gotV)) {
              obsStats.observationVersionsSeen.push(gotV);
              hard(`schema ${schema}: the recording gateway's request attestations are observation version ` +
                   `${gotV}; this verdict derives version ${OBSERVATION_VERSION}. Version 1 hashed only ` +
                   `[seq, t, kind] of each in-process event, leaving every event's DETAIL — the host, the ` +
                   `port, the path class, the field each claim is decided from — attested by nothing; a ` +
                   `detail rewritten in both instrument-side copies produced a certifying PASS. This ` +
                   `artefact directory predates that binding and cannot be certified from; drive it again.`);
            }
          }
          if (got.digest !== wantDigest) {
            obsStats.attestationsMismatched++;
            const diffs = diffObservations(want, got);
            hard(`${schema}/${cellId}/${r.id}: the cell result does not describe the request the gateway ` +
                 `witnessed (result digest ${wantDigest.slice(0, 16)}, gateway logged ${String(got.digest).slice(0, 16)}) — ` +
                 `${diffs.slice(0, 4).join("; ")}${diffs.length > 4 ? `; …and ${diffs.length - 4} more fields` : ""}`);
          } else {
            obsStats.attestationsMatched++;
          }
          if (got.cellAtGateway !== tag) {
            hard(`${schema}/${cellId}/${r.id}: the gateway was serving cell ${JSON.stringify(got.cellAtGateway)} when ` +
                 `it recorded this observation, not ${tag}`);
          }
          if (win && win.bounded) {
            const t0 = Number(r.t0), t1 = Number(r.t1);
            if (!Number.isFinite(t0) || !Number.isFinite(t1) ||
                t0 < win.from || t1 >= win.to || t1 < t0) {
              obsStats.timingOutsideWindow++;
              hard(`${schema}/${cellId}/${r.id}: the result says this request ran ${t0}..${t1} but the gateway's ` +
                   `window for ${tag} is ${win.from}..${win.to} — a request observation filed under a cell it did ` +
                   `not happen in`);
            }
          }
        }
      }

      // The two host-side observers get their liveness stated here, the same
      // way the driver states the in-process ones.
      const sensors = Object.assign({}, r.sensors || {}, {
        canary: canary
          ? { live: true }
          : { live: false, reason: O.breakSensor === "verdict"
              ? "the verdict was told not to read the sensor" : "no canary reading for this schema" },
        sensorRunner: sensorVerdict === "TRUSTWORTHY"
          ? { live: true }
          : { live: false, reason: `sensor runner reported ${sensorVerdict || "nothing"}` },
      }, observerSensors || {});
      // A driver that predates the typed report contributes no sensor block at
      // all; that is a malformed result, not an excuse to assume the best.
      if (!r.sensors) {
        hard(`schema ${schema}/${cell.cell}/${r.id}: the driver reported no sensor block`);
      }

      const records = buildClaims({
        request: r,
        response: r.response || null,
        error: r.error || null,
        // THE OBSERVER'S COPY, not the driver's transcription of it. For a
        // non-certifying fixture there is no observer index and this falls back
        // to `r.events`; a non-certifying manifest can never print PASS.
        events: claimEvents,
        marks: r.markDelta || {},
        routeExec: r.routeExec,
        sensors,
        sinkEntries,
        canaryHits: pgHits,
        canaryRows,
        canaryAttributable: Boolean(canary) && sensorVerdict === "TRUSTWORTHY",
        policy: {
          expectStatus: O.expectStatus,
          // Committed, not hard-coded: what the frozen artifact's refusal must
          // LOOK like, not merely that something returned 503.
          refusalIdentity: MANIFEST.refusalIdentity || null,
        },
      });

      // --- 2. COMPLETENESS --------------------------------------------------
      const problems = checkCompleteness(records, `${schema}/${cell.cell}/${r.id}`);
      for (const p of problems) hard(p);

      const s = summarise(records);
      if (s.violated) { totalViolating++; cellHasFinding = true; }
      if (s.indeterminate) {
        totalIndeterminate++;
        hard(`${schema}/${cell.cell}/${r.id}: ${s.indeterminate} claims are INDETERMINATE ` +
             `(${s.indeterminateClaims.join(",")}) — an unread sensor is not a clean result`);
      }

      tally(records);
      allRows.push({ cell: cell.cell, r, s, records });
    }

    /* ---- ADV-1. EVERY LINE OF THE IMAGE'S OWN LOG MUST BE ACCOUNTED FOR ----
     * The loop above decides the claims from the events INSIDE the gateway's
     * request windows. Those windows cover about 11% of a cell's gateway
     * timeline — the rest is #witness and #idle — so an auditor took the D
     * attack, moved it 742 ms past the cell's last window, and got a full
     * certifying PASS with "noBrokerCall: 480 satisfied, 0 violated". The
     * three planted events were byte-faithful to what instrument.cjs emit()
     * writes, and no forgery was required: the instrument patches
     * fetch/socket/tls/dns process-wide at module load, so it records exactly
     * such a call by construction.
     *
     * A claim decided over a window says nothing about the complement of that
     * window. This says something about the complement: an event there is
     * UNATTRIBUTED — nothing in this run explains it — and that is a refusal,
     * not a silence. It is deliberately NOT filtered by event kind: a filter
     * would reopen the hole for whichever kind was thought innocent. */
    if (gw) {
      const ilog = instrumentLog(O.out, schema, cellId, instrumentLogCache);
      const att = attributeEvents(
        ilog.events,
        cell.bootEvents,
        cell.results.map((r) => [r.cellTag, gw.windows.get(r.cellTag)]));
      obsStats.logEvents += ilog.events.length;
      /* R7-1. THE IMAGE'S OWN LOG, LINE BY LINE, INCLUDING THE LINES THAT DID
       * NOT PARSE. instrument.cjs appends each event with its own
       * fs.appendFileSync and run.sh SIGKILLs the app container at the end of
       * every cell, so a truncated or interleaved line is a NORMAL-OPERATION
       * outcome — and until round 7 that outcome was discarded silently by
       * `parseJsonl`, which is also what let one byte turn ADV-1's refusal
       * into a certifying PASS. */
      obsStats.rawLines += ilog.rawLines;
      obsStats.instrLinesUnparseable += ilog.unparseable.length;
      obsStats.linesUnparseable += ilog.unparseable.length;
      for (const u of ilog.unparseable) noteUnparseable(obsStats, ilog.rel, u);
      for (const u of ilog.unparseable.slice(0, 3)) {
        hard(`schema ${schema}/${cellId}: ${describeUnparseable(ilog.rel, u)} — a line of the IMAGE'S OWN LOG ` +
             `that does not parse, so nothing in this run can say what it records. It is not a truncated tail ` +
             `that may be ignored: the attribution pass, the observer/transcription diff and every in-process ` +
             `claim are decided from the ${ilog.events.length} line(s) of this file that DID parse, out of ` +
             `${ilog.rawLines} non-empty lines (check with: grep -c . ${ilog.rel}). MEASURED — a byte-faithful ` +
             `broker fetch planted 742 ms into #idle is refused as UNATTRIBUTED; the same record with its ` +
             `final '}' replaced by a space, at identical byte and line counts, certified.`);
      }
      if (ilog.unparseable.length > 3) {
        hard(`schema ${schema}/${cellId}: …and ${ilog.unparseable.length - 3} further unparseable line(s) in ` +
             `${ilog.rel} (the first three are named above)`);
      }
      /* R7-2. AN ALLOW-LIST OVER THE RECORD'S TOP-LEVEL KEYS, for the same
       * reason `bootEventProblem` is an allow-list over kinds: `eventIdentity`
       * covers seq/t/kind/detail and excludes `stack` deliberately, so an
       * unknown key was covered by nothing at all. MEASURED: a `brokerCall`
       * object appended to an existing boot line left the raw line count, the
       * event count, the boot count and the unattributed count all identical,
       * and certified. */
      const foreign = [];
      for (let i = 0; i < ilog.events.length; i++) {
        const keys = eventForeignKeys(ilog.events[i]);
        if (keys.length) {
          foreign.push({ lineNo: ilog.eventLineNos[i], keys, event: ilog.events[i] });
        }
      }
      obsStats.eventsWithForeignKeys += foreign.length;
      for (const f of foreign) {
        if (obsStats.foreignKeyDetail.length < UNPARSEABLE_DETAIL_CAP) {
          obsStats.foreignKeyDetail.push({ file: ilog.rel, lineNo: f.lineNo, keys: f.keys });
        }
      }
      for (const f of foreign.slice(0, 3)) {
        hard(`schema ${schema}/${cellId}: ${ilog.rel}:${f.lineNo} (${describeEvent(f.event)}) carries ` +
             `top-level key(s) ${f.keys.map((k) => JSON.stringify(k)).join(", ")}, which instrument.cjs does ` +
             `not write and the attested event identity does not cover. The identity is ` +
             `[seq, t, kind, sha(detail)]; \`stack\` is excluded from it deliberately and is permitted on the ` +
             `record, so the permitted set is exactly ${EVENT_TOP_LEVEL_KEYS.join(", ")} and anything else is ` +
             `refused rather than ignored. MEASURED: appending a "brokerCall" object naming ` +
             `https://paper-api.alpaca.markets/v2/orders to an existing boot line changed no published count ` +
             `and certified. If a future instrument.cjs really gains a field, add it to EVENT_TOP_LEVEL_KEYS ` +
             `and to eventIdentity in the same change.`);
      }
      if (foreign.length > 3) {
        hard(`schema ${schema}/${cellId}: …and ${foreign.length - 3} further event(s) in ${ilog.rel} carrying ` +
             `an unrecognised top-level key`);
      }
      /* R8-2. THE IMAGE'S OWN CLASS LABEL, CHECKED AGAINST THE IMAGE'S OWN URL.
       *
       * No claim reads `detail.pathClass` any more — claims.mjs derives the
       * class from the `pathname`/`path`/`url` written beside it in the same
       * record — but the field is still written and still attested, so a record
       * that contradicts itself is a record that cannot be believed, and it is
       * refused rather than resolved in either direction. This is the same
       * treatment `attributeGatewayRows` gives a mislabelled gateway row.
       *
       * NOT the same thing as the self-classified-HOST limit in the scope
       * output: an image that writes the wrong host string in every field is
       * still believed here. This catches the record that disagrees with
       * itself, which is all a cross-check between two fields of one record
       * can catch. */
      const contradictions = [];
      for (let i = 0; i < ilog.events.length; i++) {
        const e = ilog.events[i];
        if (!e || !REQUEST_EGRESS_KINDS.includes(e.kind)) continue;
        const d = e.detail || {};
        const declared = typeof d.pathClass === "string" ? d.pathClass : null;
        if (declared === null) continue;
        let p2 = null;
        if (typeof d.pathname === "string" && d.pathname !== "") p2 = d.pathname;
        else if (typeof d.path === "string" && d.path !== "") p2 = d.path;
        else if (typeof d.url === "string" && d.url !== "") {
          try { p2 = new URL(d.url).pathname; } catch { p2 = null; }
        }
        // No readable destination path: there is nothing to compare against,
        // and instrument.cjs answers "unclassified" for exactly that case.
        if (p2 === null) continue;
        const derived2 = classifyGatewayPath(p2);
        if (declared !== derived2) {
          contradictions.push({ lineNo: ilog.eventLineNos[i], event: e, declared, derived: derived2, path: p2 });
        }
      }
      obsStats.imageEgressPathClassContradictions += contradictions.length;
      for (const c of contradictions.slice(0, 3)) {
        hard(`schema ${schema}/${cellId}: ${ilog.rel}:${c.lineNo} (${describeEvent(c.event)}) declares ` +
             `pathClass=${JSON.stringify(c.declared)} for path ${JSON.stringify(c.path)}, which classifies as ` +
             `'${c.derived}'. Nothing decides a claim from the declared class — the surface is derived from ` +
             `the path — but a record whose two halves disagree is refused rather than believed in either ` +
             `direction.`);
      }
      if (contradictions.length > 3) {
        hard(`schema ${schema}/${cellId}: …and ${contradictions.length - 3} further event(s) in ${ilog.rel} ` +
             `whose declared pathClass contradicts their own URL`);
      }
      obsStats.eventsAttributedToBoot += att.boot;
      obsStats.eventsAttributedToWindow += att.inWindow;
      obsStats.eventsInMoreThanOneWindow += att.multiWindow.length;
      obsStats.eventsUnattributed += att.unattributed.length;
      for (const [k, n] of Object.entries(att.bootKinds)) {
        obsStats.bootEventKinds[k] = (obsStats.bootEventKinds[k] || 0) + n;
      }
      obsStats.bootEventsRefused += att.bootProblems.length;
      // Attributed is not the same as innocent: nothing decides a CLAIM from a
      // boot event, so the boot bucket would otherwise absorb an outbound call
      // in silence. See `bootEventProblem` in observers.mjs.
      for (const bp of att.bootProblems.slice(0, 3)) {
        hard(`schema ${schema}/${cellId}: the boot snapshot carries ${describeEvent(bp.event)} — ${bp.problem} ` +
             `(${ilog.rel})`);
      }
      if (att.bootProblems.length > 3) {
        hard(`schema ${schema}/${cellId}: …and ${att.bootProblems.length - 3} further boot-snapshot event(s) of the same kind`);
      }
      if (att.multiWindow.length) {
        const m = att.multiWindow[0];
        hard(`schema ${schema}/${cellId}: ${att.multiWindow.length} event(s) in ${ilog.rel} fall inside MORE than ` +
             `one of the gateway's request windows (first: ${describeEvent(m.event)} in ${m.tags.join(", ")}); ` +
             `the windows for one cell are consecutive by construction, so they cannot overlap in a real run`);
      }
      if (att.unattributed.length) {
        hard(`schema ${schema}/${cellId}: ${att.unattributed.length} of ${ilog.events.length} event(s) in the ` +
             `IMAGE'S OWN LOG (${ilog.rel}) are UNATTRIBUTED — they are neither in the boot snapshot this cell ` +
             `result declares (${Array.isArray(cell.bootEvents) ? cell.bootEvents.length : 0} events) nor inside ` +
             `any of the ${att.windowsUsable} bounded request windows the recording gateway logged for this cell ` +
             `[${att.unattributed.slice(0, 3).map(describeEvent).join("; ")}` +
             `${att.unattributed.length > 3 ? `; …and ${att.unattributed.length - 3} more` : ""}]. ` +
             `The request windows cover only the time the driver was issuing requests; the rest of the cell's ` +
             `timeline is the #witness and #idle bookends. An event there is not innocent — it is one nothing ` +
             `in this run accounts for, and the instrument records fetch/socket/tls/dns process-wide.`);
      }
    }

    if (cellHasFinding) cellsWithFindings++;
  }

  /* ADV-1, second half: an instrument log for THIS generation that no cell
   * result claims. `attributeEvents` accounts for the lines of every log a
   * result points at; a log nothing points at would otherwise be evidence in
   * the artefact directory that the verdict never opened. */
  if (gw) {
    const instrDir = path.join(O.out, "instr");
    const claimed = new Set(drivenIds);
    let files = [];
    try { files = fs.readdirSync(instrDir); }
    catch (e) {
      hard(`schema ${schema}: the image's own log directory ${path.relative(O.out, instrDir)} cannot be read ` +
           `(${e.message}); every in-process claim would fall back to the driver's account of itself`);
    }
    for (const f of files) {
      if (!f.startsWith(`${schema}-`) || !f.endsWith(".jsonl")) continue;
      const id = f.slice(`${schema}-`.length, -".jsonl".length);
      if (claimed.has(id)) continue;
      const n = readLines(path.join(instrDir, f)).length;
      obsStats.instrumentLogsWithoutAResult++;
      hard(`schema ${schema}: instr/${f} carries ${n} instrument event line(s) for a cell '${id}' that has no ` +
           `result file in this verdict; the image under test emitted events nothing in this run accounts for`);
    }
  }

  /* ROUND-5 AUDIT. THE SAME QUESTION, ASKED OF THE SECOND OBSERVER.
   *
   * ADV-1 made every line of the IMAGE's log account for itself. Nothing made
   * the GATEWAY's log account for itself, and the gateway is the observer that
   * exists precisely because the instrument runs inside the thing under test.
   * It was read in exactly one way — `sinkMap.get(<cell>#<n>)`, per request —
   * so an entry under `#witness`, `#idle` or `(unset)` was parsed, bucketed and
   * judged by nothing.
   *
   * MEASURED: a `GET /rest/v1/accounts` and a `GET /auth/v1/user`, in the shape
   * sink.mjs writes, inserted under one cell's `#idle` tag with nothing else
   * touched — no instrument event, no cell result — produced a full certifying
   * PASS with `noPostgRESTCall: 480 satisfied, 0 violated`. Under a request tag
   * the identical pair is refused, which is the positive control that the
   * reading path works and the complement was the hole. See observers.mjs
   * `attributeGatewayRows`. */
  if (gw) {
    /* The bookend tags this run's OWN cell results account for. A harness row
     * under `<id>#witness` or `<id>#idle` is the driver's protocol only if the
     * driver drove that cell; a tag the image invented is not. */
    const bookendTags = new Set();
    for (const id of drivenIds) { bookendTags.add(`${id}#witness`); bookendTags.add(`${id}#idle`); }
    const att = attributeGatewayRows(gw.rows, claimedRequestTags, bookendTags);
    obsStats.gatewayRows = att.total;
    obsStats.gatewayHarnessRows = att.harness;
    obsStats.gatewayRowsInAClaimedRequest = att.inClaimedRequest;
    obsStats.gatewayRowsUnaccounted = att.unaccounted.length;
    obsStats.gatewayRowsMislabelled = att.mislabelled.length;
    obsStats.gatewayRowsByClass = att.byClass;
    obsStats.gatewayRowsWithoutADeclaredKind = att.withoutADeclaredKind;
    obsStats.gatewayHarnessAccounted = att.harnessAccounted;
    obsStats.gatewayHarnessUnaccounted = att.harnessUnaccounted.length;
    obsStats.gatewayHarnessByShape = att.harnessByShape;
    /* ROUND-9. The last unaccounted bucket. Every /__canary row must be one the
     * driver's protocol produces — the right path, by the right method, under a
     * tag class the protocol puts it in, under a tag this run's cell results
     * account for, and once. Anything else is a call to the gateway's control
     * plane by something that is not the driver, which is a network reach by
     * the process under test that no claim reads. */
    if (att.harnessUnaccounted.length) {
      const shown = att.harnessUnaccounted.slice(0, 3)
        .map((u) => `${describeGatewayRow(u.row)} — ${u.why}`).join("; ");
      hard(`schema ${schema}: ${att.harnessUnaccounted.length} of ${att.harness} /__canary entries in ` +
           `sink-${schema}.jsonl are not traffic the driver's protocol produces [${shown}` +
           `${att.harnessUnaccounted.length > 3 ? `; …and ${att.harnessUnaccounted.length - 3} more` : ""}]. ` +
           `'harness' is the one class GATEWAY_CLASS_READERS maps to no claim, and the exemption is ` +
           `derived from the path — which stops a /rest/v1 row buying it with a word, but grants it to ` +
           `ANY caller of /__canary, and the recording gateway serves that surface unauthenticated to ` +
           `every container on its network, the image under test included. So the exemption is now ` +
           `granted to the driver's PROTOCOL instead of to the prefix: ` +
           Object.entries(HARNESS_PROTOCOL)
             .map(([tc, m]) => `${tc}{${Object.entries(m).map(([pp, mm]) => `${mm} ${pp}`).join(", ") || "nothing"}}`)
             .join(" "), );
    }
    if (att.mislabelled.length) {
      const m = att.mislabelled[0];
      hard(`schema ${schema}: ${att.mislabelled.length} entries in sink-${schema}.jsonl declare a kind that ` +
           `their own path contradicts (first: ${describeGatewayRow(m.row)} — the path classifies as ` +
           `'${m.derived}'). The harness-control exemption is derived from the path, so a data-plane entry ` +
           `cannot buy it by calling itself 'harness'; a row that disagrees with itself is refused rather ` +
           `than resolved in either direction.`);
    }
    if (att.unaccounted.length) {
      hard(`schema ${schema}: ${att.unaccounted.length} of ${att.total} entries in the RECORDING GATEWAY'S ` +
           `OWN LOG (sink-${schema}.jsonl) are not the harness's own control traffic and do not fall under ` +
           `any request tag a cell result claims ` +
           `[${att.unaccounted.slice(0, 3).map(describeGatewayRow).join("; ")}` +
           `${att.unaccounted.length > 3 ? `; …and ${att.unaccounted.length - 3} more` : ""}]. ` +
           /* R8-4. THE SENTENCE THIS USED TO CARRY WAS FALSIFIED BY R8-1 AND IS
            * REPLACED BY WHAT THE CODE NOW ENFORCES. It said an entry under
            * #witness/#idle/(unset) "is one that noAuthCall, noPostgRESTCall
            * and noDatabaseCall never saw, because those are decided per
            * request" — which asserts that an entry under a REQUEST tag IS seen
            * by them. It was seen only if it labelled itself: those three
            * claims filtered on the row's own `kind`, so deleting that one
            * field from a row recording GET /rest/v1/accounts inside a claimed
            * request produced rc=0 with noPostgRESTCall 480 satisfied / 0
            * violated. Since round 8 the class is derived from the path in
            * claims.mjs, every class is read by a named claim, and the
            * statement below is true of the code as it stands. */
           `The gateway stands in for Supabase. A row's SURFACE is derived from its path here and in ` +
           `every claim (claims.mjs classifyGatewayPath), never read off the row: a row under a request ` +
           `tag some cell result claims is decided by the claims that read its class — /auth/v1 by ` +
           `noAuthCall, /rest/v1 and /rest/v1/rpc/ by noPostgRESTCall and noDatabaseCall, /graphql/v1 ` +
           `and /pg by noDatabaseCall, /storage/v1, /realtime/v1, /functions/v1, the Kong root and any ` +
           `unclassified path by noUnexpectedNetworkCall — whatever its \`kind\` field says or does not ` +
           `say. What THIS check adds is the complement: a row outside every claimed request tag is ` +
           `under no request, so no per-request claim is decided from it at all. Measured 0 across four ` +
           `genuine certifying runs and 3960 entries. ` +
           /* R9-1. AND THE OTHER HALF OF THE COMPLEMENT, WHICH THIS SENTENCE
            * USED TO GIVE AWAY: "only the harness's own /__canary control
            * traffic may be there". /__canary rows are exempt from THIS check
            * by their derived class, and they are not only "there" — 480 of
            * the 555 rows a genuine generation writes are /__canary rows
            * INSIDE claimed request tags (the tag announcement and the request
            * attestation). No claim reads them, and the gateway serves that
            * surface to anything on its network. They are therefore accounted
            * separately now, against the driver's protocol. */
           `The /__canary rows themselves — the class no claim reads — are accounted against the driver's ` +
           `PROTOCOL rather than exempted by prefix: ` +
           Object.entries(HARNESS_PROTOCOL)
             .map(([tc, m]) => `${tc}{${Object.entries(m).map(([pp, mm]) => `${mm} ${pp}`).join(", ") || "nothing"}}`)
             .join(" ") + `, once each per tag except the readiness poll, and under a tag this run's own ` +
           `cell results account for. ${obsStats.gatewayHarnessAccounted} accounted, ` +
           `${obsStats.gatewayHarnessUnaccounted} refused on this generation.`);
    }
  }

  // --- 1c. the DRIVEN identity set must be the pinned one -------------------
  // This is the check the audit's three reproductions all fail. It is stated as
  // a set equality rather than a count so that "twenty-four files" and
  // "twenty-four combinations" can no longer be the same sentence.
  {
    const uniq = new Set(drivenIds);
    const dupes = [...new Set(drivenIds.filter((id, i) => drivenIds.indexOf(id) !== i))];
    console.log(`   distinct cell identities driven : ${uniq.size} of ${drivenIds.length} result files`);
    if (dupes.length) {
      hard(`schema ${schema}: ${dupes.length} cell identity/identities appear more than once ` +
           `(${dupes.slice(0, 6).join(", ")}${dupes.length > 6 ? ", …" : ""}); ` +
           `${uniq.size} distinct combinations were driven, not ${drivenIds.length}`);
    }
    if (CELL_IDS) {
      const missing = CELL_IDS.filter((id) => !uniq.has(id));
      const unknown = [...uniq].filter((id) => !CELL_IDS.includes(id));
      if (unknown.length) {
        hard(`schema ${schema}: ${unknown.length} driven cell(s) are not in the committed identity set ` +
             `(${unknown.slice(0, 6).join(", ")}${unknown.length > 6 ? ", …" : ""})`);
      }
      if (!CELLS_PARTIAL) {
        // A complete run must have driven EVERY pinned combination.
        if (missing.length) {
          hard(`schema ${schema}: ${missing.length} of the ${CELL_IDS.length} committed environment combinations were never driven ` +
               `(${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}); ` +
               `a verdict over the rest is a verdict over a subset`);
        }
      } else if (uniq.size !== O.cellsRun) {
        hard(`schema ${schema}: a partial run declared ${O.cellsRun} combinations but drove ${uniq.size} distinct ones`);
      }
    }
  }

  // --- the matrix, printed --------------------------------------------------
  console.log(
    "".padEnd(4) + "cell".padEnd(34) + "method  endpoint".padEnd(40) +
    "auth".padEnd(6) + "code".padEnd(6) + "claims (ok/viol/indet)".padEnd(24) + "detail");
  for (const row of allRows) {
    const { cell, r, s, records } = row;
    const bad = records.filter((x) => x.status !== "satisfied");
    const line =
      "".padEnd(4) +
      cell.padEnd(34) +
      `${r.method} ${r.template}`.padEnd(40) +
      (r.authenticated ? "yes" : "no").padEnd(6) +
      String(r.response ? r.response.status : "ERR").padEnd(6) +
      `${s.satisfied}/${s.violated}/${s.indeterminate}`.padEnd(24) +
      (bad.length
        ? `${RED}${bad.map((x) => `${x.claim}=${x.status}(${x.detail})`).join("  ")}${OFF}`
        : `${GREEN}—${OFF}`);
    console.log(line);
  }

  // --- schema-level readings ------------------------------------------------
  let hitDelta = null;
  if (canary) {
    hitDelta = {};
    for (const fn of Object.keys(canary.hits)) hitDelta[fn] = canary.hits[fn] - (base[fn] || 0);
  }
  const totalHitDelta = hitDelta ? Object.values(hitDelta).reduce((a, b) => a + b, 0) : null;

  const commitDeltaFile = path.join(O.out, `commit-deltas-${schema}.txt`);
  const commitMoved = fs.existsSync(commitDeltaFile) && fs.statSync(commitDeltaFile).size > 0;

  console.log(`\n   requests driven                : ${totalRequests}` +
              (PARTIAL ? ` (manifest total: ${MANIFEST.totalRequests})` : ""));
  console.log(`   claim records evaluated        : ${totalRequests * REQUIRED_CLAIMS.length}`);
  console.log(`   requests with a violated claim : ${totalViolating}`);
  console.log(`   requests with an INDETERMINATE : ${totalIndeterminate}`);
  console.log(`   cells with any violation       : ${cellsWithFindings}`);
  console.log(`   canary baseline (post-arming)  : ${JSON.stringify(base)}`);
  console.log(`   canary final                   : ${canary ? JSON.stringify(canary.hits) : "(NOT CONSULTED)"}`);
  console.log(`   canary hits caused by the run  : ${canary ? JSON.stringify(hitDelta) : "(NOT CONSULTED)"}`);
  console.log(`   canary detail rows committed   : ${canary ? canary.rows.length : "(NOT CONSULTED)"}`);
  console.log(`   sensor runner verdict          : ${sensorVerdict || "(NONE SUPPLIED)"}` +
              (report.verdict
                ? ` (read out of ${report.rel}; --sensor-verdict said ${declaredSensorVerdict || "nothing"})`
                : ` (NOT DERIVABLE FROM THE ARTEFACTS: ${report.reason})`));
  console.log(`   in-process claims decided from : ${obsStats.derivedFrom}` +
              (gw ? ` — ${obsStats.windows} gateway-defined request windows, ` +
                    `${obsStats.observerEvents} instrument events in them, ` +
                    `${obsStats.eventsOnlyInObserverLog + obsStats.eventsOnlyInTranscription} disagreeing with the driver's transcription`
                  : ""));
  if (gw) {
    console.log(`   request observations attested  : ${obsStats.attestationsMatched} matched the gateway's own copy, ` +
                `${obsStats.attestationsMissing} missing, ${obsStats.attestationsMismatched} contradicted, ` +
                `${obsStats.timingOutsideWindow} timed outside their window`);
    // R7-1: the DENOMINATOR first. `logEvents` used to be printed as though it
    // were the size of the file; it is the size of the PARSED set, and one
    // byte was enough to make the two differ silently.
    console.log(`   image-log lines accounted for  : ${obsStats.logEvents} of ${obsStats.rawLines} non-empty ` +
                `line(s) parsed` +
                (obsStats.instrLinesUnparseable
                  ? ` (${RED}${obsStats.instrLinesUnparseable} UNPARSEABLE${OFF})`
                  : "") +
                ` = ${obsStats.eventsAttributedToBoot} boot + ${obsStats.eventsAttributedToWindow} in a request window + ` +
                `${obsStats.eventsUnattributed} ${obsStats.eventsUnattributed ? `${RED}UNATTRIBUTED${OFF}` : "unattributed"}` +
                (obsStats.eventsInMoreThanOneWindow ? ` + ${obsStats.eventsInMoreThanOneWindow} in overlapping windows` : ""));
    console.log(`   event records, top-level keys  : ${EVENT_TOP_LEVEL_KEYS.join("/")} permitted, ` +
                `${obsStats.eventsWithForeignKeys} record(s) carrying anything else` +
                (obsStats.eventsWithForeignKeys ? ` ${RED}REFUSED${OFF}` : ""));
    console.log(`   boot snapshot, by kind         : ${JSON.stringify(obsStats.bootEventKinds)}` +
                (obsStats.bootEventsRefused ? ` ${RED}(${obsStats.bootEventsRefused} refused)${OFF}` : ""));
    console.log(`   gateway-log lines accounted for: ${obsStats.gatewayRows} of ${obsStats.gatewayRawLines} ` +
                `non-empty line(s) parsed` +
                (obsStats.gatewayLinesUnparseable
                  ? ` (${RED}${obsStats.gatewayLinesUnparseable} UNPARSEABLE${OFF})`
                  : "") +
                ` = ${obsStats.gatewayHarnessRows} harness control + ` +
                `${obsStats.gatewayRowsInAClaimedRequest} inside a claimed request + ` +
                `${obsStats.gatewayRowsUnaccounted} ` +
                `${obsStats.gatewayRowsUnaccounted ? `${RED}UNACCOUNTED${OFF}` : "unaccounted"}`);
    /* R9-1. And the harness control rows themselves, which used to be counted
     * and skipped. The class no claim reads is the one the image can also
     * reach, so its rows must match the driver's protocol or be refused. */
    console.log(`   /__canary rows vs the protocol  : ${obsStats.gatewayHarnessAccounted} accounted + ` +
                `${obsStats.gatewayHarnessUnaccounted} ` +
                `${obsStats.gatewayHarnessUnaccounted ? `${RED}NOT THE DRIVER'S PROTOCOL${OFF}` : "not the driver's protocol"}` +
                ` (shapes: ${Object.entries(obsStats.gatewayHarnessByShape)
                  .sort().map(([k, n]) => `${k} x${n}`).join(", ") || "none"})`);
    /* R8-2. WHICH SUPABASE SURFACE, printed rather than left to the JSON. Every
     * class the classifier can return is listed, including the ones with a
     * count of zero, so a reader can see that /storage/v1, /realtime/v1,
     * /functions/v1, /graphql/v1, /pg and the Kong root are surfaces this run
     * looked for and did not find — as opposed to surfaces it has no notion
     * of, which is what they were until round 8. */
    console.log(`   gateway rows by surface        : ` +
                GATEWAY_PATH_CLASSES.map((c) => {
                  const n = obsStats.gatewayRowsByClass[c] || 0;
                  const bad = n > 0 && c !== "harness";
                  return `${c}=${bad ? `${RED}${n}${OFF}` : n}`;
                }).join(" ") +
                (obsStats.gatewayRowsWithoutADeclaredKind
                  ? ` (${obsStats.gatewayRowsWithoutADeclaredKind} row(s) carried no kind field; the class is ` +
                    `derived from the path, so it changes nothing)`
                  : ""));
    console.log(`   image egress, declared vs URL  : ` +
                `${obsStats.imageEgressPathClassContradictions} record(s) whose pathClass contradicts their ` +
                `own path` +
                (obsStats.imageEgressPathClassContradictions ? ` ${RED}REFUSED${OFF}` : ""));
  }
  console.log(`   before/after commitments       : ${commitMoved ? `${RED}MOVED${OFF} (see commit-deltas-${schema}.txt)` : `${GREEN}unchanged across every cell${OFF}`}`);

  if (sensorVerdict !== "TRUSTWORTHY") {
    hard(`schema ${schema}: the trusted sensor runner reported ${sensorVerdict || "nothing"}; ` +
         `no absence measured on this database is evidence`);
  }

  // --- what the MATRIX moved, as opposed to what the sensor runner moved ----
  //
  // The trusted runner challenges the sensor during and after the matrix, and
  // those challenges advance the same rollback-proof counters. They are not
  // filtered out by pattern-matching a tag: the caller states how many it
  // caused, and the two independent channels must then agree exactly. A
  // mismatch is a control failure, not a note.
  let matrixHits = null;
  let perWrapperMatrix = null;
  if (canary && totalHitDelta !== null) {
    const declared = Number.isFinite(O.sensorHits[schema]) ? O.sensorHits[schema] : 0;
    // …and how many the RUNNER's own ledger says it caused after the baseline.
    // `--sensor-hits` decided how many counter movements were subtracted from
    // the matrix's account, so an inflated value hid real hits and nothing
    // contradicted it. It is now derived from the runner's phase accounting.
    if (report.challengeHitsAfterBaseline !== null && report.challengeHitsAfterBaseline !== undefined
        && report.challengeHitsAfterBaseline !== declared) {
      hard(`schema ${schema}: --sensor-hits declares ${declared} challenge hits after the baseline but ` +
           `${report.rel} accounts for ${report.challengeHitsAfterBaseline} ` +
           `(mid=${report.phases.mid}, post=${report.phases.post}); the subtracted total is not the runner's`);
    }
    matrixHits = totalHitDelta - declared;
    // WHICH wrappers the matrix reached, not just how many hits there were.
    // Property B was reported as "the sensor is live" while all 48 of its hits
    // were `vault_delete_secret`: the end-to-end path was demonstrated for one
    // of the three wrappers and the report did not say so. The trusted runner
    // fires each wrapper once per challenge round, so the declared total
    // divides evenly by three.
    const perRound = declared / 3;
    if (Number.isInteger(perRound)) {
      perWrapperMatrix = {};
      for (const fn of Object.keys(hitDelta)) perWrapperMatrix[fn] = hitDelta[fn] - perRound;
      console.log(`   canary hits per wrapper, matrix-attributed : ${JSON.stringify(perWrapperMatrix)}`);
    }
    const logLines = readLines(path.join(O.out, `pglog-hits-${schema}.txt`))
      .filter((l) => !/cell=(arming-probe|chal:)/.test(l)).length;
    console.log(`   counter delta                  : ${totalHitDelta} ` +
                `(${declared} declared by the sensor runner, ${matrixHits} attributed to the matrix)`);
    if (matrixHits < 0) {
      hard(`schema ${schema}: the sensor runner declared ${declared} challenge hits but the counters only moved ${totalHitDelta}`);
    } else if (matrixHits !== logLines) {
      hard(`schema ${schema}: ${matrixHits} matrix-attributed counter movements but ${logLines} ` +
           `matrix-attributable server-log lines; the two non-transactional channels disagree`);
    } else {
      console.log(`   two independent hit channels agree on the matrix: ${matrixHits}`);
    }
  }

  summary.push({ schema, totalRequests, totalViolating, totalIndeterminate, totalHitDelta: matrixHits, perWrapperMatrix, commitMoved, sensorVerdict });
}


/* ==========================================================================
 * R7-3 / R7-4. THE RUN'S OWN CONTROLS AND THE IMAGE'S OWN STDOUT, RE-DERIVED
 * HERE, FROM THEIR ARTEFACTS
 *
 * Audit finding F says an absence is only evidence from a detector KNOWN to
 * work. It was closed for exactly ONE detector — the trusted runner's sensor
 * report, above. Four other controls were asserted inside run.sh's own
 * process and read by nothing afterwards, and a fifth artefact, the image's
 * own stdout, was collected and never opened at all. MEASURED against the
 * shipped code, over a genuine 48-cell certifying set:
 *
 *   * deleting `instr/egress-control.jsonl` and `instr/egress-broker.txt`
 *     alone                                                    -> rc=0 PASS
 *   * deleting those two plus `canary-arm-<gen>.txt`,
 *     `sql/arm-<gen>.{out,err}`, `sql/on-error-stop-<gen>.err` and
 *     `tombstone-<gen>.txt`                                     -> rc=0 PASS,
 *     with no mention of any of them anywhere in the transcript or in
 *     verdict-scope.json (a case-insensitive grep over the stripped
 *     transcript for all four names: 0 hits)
 *   * appending two lines to `instr/0023-m-off__s-off__b-probe.applog` — a
 *     `[broker] POST https://paper-api.alpaca.markets/v2/orders … -> 200 OK`
 *     and a `[vault] rpc vault_create_secret(…) -> ok`          -> rc=0 PASS
 *
 * §3c is the control that makes `noBrokerCall` MEAN anything: it is the proof
 * that the in-process classifier calls paper-api.alpaca.markets a broker and
 * does NOT call the recording gateway one. Its passing value — the
 * `noBrokerCall: 480 satisfied` row — is byte-identical to the value the
 * matrix produces when the classifier was never shown to work at all.
 *
 * So each control is now RE-DERIVED from its artefact and published as a
 * named boolean, with the numbers behind it, in `verdict-scope.json` beside
 * `sensorVerdict`. Absent evidence refuses; it is not silence.
 *
 * WHAT THIS IS AND IS NOT. The control still RUNS in run.sh's process — that
 * is where the containers are. What changes is that its artefact must now
 * exist, must be internally consistent, and must say what the control claims
 * it said, or this file will not certify. That defeats deletion and partial
 * edits of the control evidence; it does not defeat an operator who rewrites
 * the artefact and the log it is cross-checked against together, which is the
 * `artefact-forgery` limit and is stated there.
 *
 * WHERE THE CONSTANTS COME FROM. The broker hosts, the gateway host and the
 * three instrumented wrapper names are pinned in THIS file, which
 * TRUSTED_DIGEST covers, and the egress control's own `instrument.loaded`
 * record must agree with the pin. Reading them out of the artefact and then
 * judging the artefact by them would be circular: an image configured with no
 * broker hosts at all would satisfy every check about broker hosts.
 * ========================================================================== */

const HARNESS_BROKER_HOSTS = [
  "paper-api.alpaca.markets", "api.alpaca.markets", "data.alpaca.markets",
];
/* HARNESS_SINK_HOST is imported from claims.mjs: the claim layer needs the
 * same constant to decide whether an egress record is addressed to the
 * recording gateway, and two copies of a pin is how the tamper-control role
 * list went wrong (finding B8(ii)). */
const INSTRUMENTED_WRAPPERS = [
  "vault_create_secret", "vault_update_secret", "vault_delete_secret",
];

const controlEvidence = {};

/** Every string in an event's `detail` that could name a host. The classifier
 *  writes `host` for fetch/socket/tls and `hostname` for dns; `url` carries it
 *  again for fetch. All of them are checked, so a record cannot dodge the
 *  discrimination test by naming the host in the field this function forgot. */
function detailHostStrings(d) {
  if (!d || typeof d !== "object") return [];
  return ["host", "hostname", "url", "servername", "origin", "authority"]
    .map((k) => d[k]).filter((v) => typeof v === "string" && v.length > 0);
}
const namesABrokerHost = (d) =>
  detailHostStrings(d).some((s) => HARNESS_BROKER_HOSTS.some((h) => s.includes(h)));
const namesTheGateway = (d) =>
  detailHostStrings(d).some((s) => s.includes(HARNESS_SINK_HOST));

/* -- §3c: the egress classifier fires, and DISCRIMINATES -------------------
 * Two-sided by construction. A classifier that answered "broker" to
 * everything would satisfy "a broker fetch produced a broker event" and make
 * every real run fail; a classifier that answered "broker" to nothing would
 * satisfy every noBrokerCall row in the matrix. Both directions are asserted,
 * and both counts are published so the assertion is not an empty set whose
 * passing value is also its failure-to-run value. */
function deriveEgressControl() {
  const rel = "instr/egress-control.jsonl";
  const relB = "instr/egress-broker.txt";
  const ev = {
    satisfied: false, reasons: [], derivedFrom: [rel, relB],
    present: false, rawLines: 0, unparseable: 0,
    instrumentLoaded: false,
    configuredBrokerHosts: null, configuredSinkHost: null, configAgreesWithPin: null,
    brokerClassified: 0, brokerClassifiedNamingABrokerHost: 0,
    sinkClassified: 0, sinkClassifiedNamingTheGateway: 0,
    gatewayNamedButClassifiedBroker: 0, brokerHostNamedButNotClassifiedBroker: 0,
    brokerFilePresent: false, brokerFileLines: null, brokerFileAgrees: null,
  };
  const f = path.join(O.out, rel);
  const fb = path.join(O.out, relB);
  const p = parseJsonlFile(f);
  ev.present = p.present;
  ev.rawLines = p.rawLines;
  ev.unparseable = p.unparseable.length;
  if (!p.present) {
    ev.reasons.push(`${rel} is absent; the egress classifier was never shown to work in this run, ` +
                    `so every noBrokerCall and noUnexpectedNetworkCall row below is an absence from ` +
                    `a detector of unknown liveness`);
    return ev;
  }
  if (p.unparseable.length) {
    ev.reasons.push(`${p.unparseable.length} of ${p.rawLines} line(s) of ${rel} do not parse ` +
                    `(first: line ${p.unparseable[0].lineNo}, ${p.unparseable[0].error}); a control whose ` +
                    `own record cannot be read has not been read`);
  }
  for (const r of p.rows) {
    const d = r && r.detail;
    if (r && r.kind === "instrument.loaded") {
      ev.instrumentLoaded = true;
      ev.configuredBrokerHosts = Array.isArray(d && d.brokerHosts) ? [...d.brokerHosts] : null;
      ev.configuredSinkHost = (d && typeof d.sinkHost === "string") ? d.sinkHost : null;
    }
    const cls = d && typeof d.hostClass === "string" ? d.hostClass : null;
    const isBrokerHost = namesABrokerHost(d);
    const isGateway = namesTheGateway(d);
    if (cls === "broker") {
      ev.brokerClassified++;
      if (isBrokerHost) ev.brokerClassifiedNamingABrokerHost++;
      if (isGateway) ev.gatewayNamedButClassifiedBroker++;
    } else if (cls === "supabase-sink") {
      ev.sinkClassified++;
      if (isGateway) ev.sinkClassifiedNamingTheGateway++;
    }
    if (isBrokerHost && cls !== null && cls !== "broker") ev.brokerHostNamedButNotClassifiedBroker++;
  }
  if (!ev.instrumentLoaded) {
    ev.reasons.push(`${rel} carries no instrument.loaded event; the control container never ran the ` +
                    `instrument, so its silence about broker calls is the silence of an absent detector`);
  } else {
    const want = [...HARNESS_BROKER_HOSTS].sort().join(",");
    const got = ev.configuredBrokerHosts ? [...ev.configuredBrokerHosts].sort().join(",") : "(none)";
    ev.configAgreesWithPin = got === want && ev.configuredSinkHost === HARNESS_SINK_HOST;
    if (!ev.configAgreesWithPin) {
      ev.reasons.push(`${rel} says the instrument was configured with brokerHosts=[${got}] ` +
                      `sinkHost=${ev.configuredSinkHost || "(none)"}, but this checkout pins ` +
                      `[${want}] / ${HARNESS_SINK_HOST}; the control proves a classifier that was not ` +
                      `the one the matrix ran against`);
    }
  }
  if (ev.brokerClassifiedNamingABrokerHost === 0) {
    ev.reasons.push(`${rel} holds no event that both names a pinned broker host and is classified ` +
                    `'broker' (${ev.brokerClassified} broker-classified event(s) in all); a real fetch to ` +
                    `paper-api.alpaca.markets produced no broker-classified event`);
  }
  if (ev.sinkClassifiedNamingTheGateway === 0) {
    ev.reasons.push(`${rel} holds no event that both names ${HARNESS_SINK_HOST} and is classified ` +
                    `'supabase-sink'; the classifier does not recognise the recording gateway, so its ` +
                    `'broker' answer is not a discrimination`);
  }
  if (ev.gatewayNamedButClassifiedBroker > 0) {
    ev.reasons.push(`${ev.gatewayNamedButClassifiedBroker} event(s) in ${rel} name ${HARNESS_SINK_HOST} ` +
                    `and are classified 'broker'; a classifier that calls the gateway a broker is not ` +
                    `discriminating and every noBrokerCall row is meaningless`);
  }
  if (ev.brokerHostNamedButNotClassifiedBroker > 0) {
    ev.reasons.push(`${ev.brokerHostNamedButNotClassifiedBroker} event(s) in ${rel} name a pinned broker ` +
                    `host and are classified as something else; the classifier is not answering 'broker' ` +
                    `to the broker`);
  }
  /* `egress-broker.txt` is run.sh's own extraction — the file the shipped
   * discrimination check greps. Re-derived here rather than trusted, because a
   * file that agrees with nothing is a file nobody read. */
  ev.brokerFilePresent = fs.existsSync(fb);
  if (!ev.brokerFilePresent) {
    ev.reasons.push(`${relB} is absent; the extraction the discrimination check greps was not kept`);
  } else {
    const wantLines = fs.readFileSync(f, "utf8").split("\n")
      .filter((l) => l !== "" && l.includes('"hostClass":"broker"'));
    const gotLines = fs.readFileSync(fb, "utf8").split("\n").filter((l) => l !== "");
    ev.brokerFileLines = gotLines.length;
    ev.brokerFileAgrees = wantLines.length === gotLines.length &&
      wantLines.every((l, i) => l === gotLines[i]);
    if (!ev.brokerFileAgrees) {
      ev.reasons.push(`${relB} holds ${gotLines.length} line(s) but re-extracting the broker-classified ` +
                      `lines of ${rel} yields ${wantLines.length}; the two disagree, so one of them was ` +
                      `edited after the control ran`);
    }
  }
  ev.satisfied = ev.reasons.length === 0;
  return ev;
}

/* -- R8-3: THE CANARY'S RAW ARTEFACT vs THE GREP THE VERDICT READS ---------
 *
 * run.sh:1748 is
 *
 *     grep -E 'NT_CANARY_' "$OUT/sql/canary-dump-<gen>.out" > "$OUT/canary-<gen>.txt"
 *
 * and `loadCanary` above reads ONLY canary-<gen>.txt. So the sensor's own dump
 * — the artefact the run collects, keeps and ships in the directory — was
 * compared with nothing.
 *
 * MEASURED, against the code as shipped before this round, on a genuine 48-cell
 * certifying set: an NT_CANARY_ROW naming vault_create_secret from cell
 * m-off__s-off__b-probe#3 gives rc=1 FINDING with noVaultCall=violated when it
 * is in canary-0023.txt, and rc=0 PASS — noVaultCall 480 satisfied / 0
 * violated — when the identical line is present ONLY in
 * sql/canary-dump-0023.out, while the directory still contains it. Re-running
 * run.sh's own one-line extraction over the artefact sitting in the directory
 * reproduces the missing row exactly.
 *
 * This is the comparison the harness ALREADY performs for egress-broker.txt
 * against egress-control.jsonl (deriveEgressControl.brokerFileAgrees); the
 * canary pair was simply left out of R7-4. It is symmetric on purpose: a line
 * in the extraction that is not in the dump is the same defect facing the other
 * way, and neither direction can be resolved from here, so both refuse.
 */
function deriveCanaryExtractionControl(schema) {
  const relRaw = `sql/canary-dump-${schema}.out`;
  const relTxt = `canary-${schema}.txt`;
  const ev = {
    satisfied: false, reasons: [], derivedFrom: [relRaw, relTxt],
    rawPresent: false, extractionPresent: false,
    rawLines: null, rawMarkerLines: null, extractionLines: null,
    agrees: null, onlyInRawDump: [], onlyInExtraction: [],
  };
  const fRaw = path.join(O.out, relRaw);
  const fTxt = path.join(O.out, relTxt);
  ev.rawPresent = fs.existsSync(fRaw);
  ev.extractionPresent = fs.existsSync(fTxt);
  if (!ev.rawPresent) {
    ev.reasons.push(`${relRaw} is absent; the canary's own dump — the artefact ${relTxt} is EXTRACTED from — ` +
                    `was not kept, so the reading every noVaultCall row is decided from is compared with ` +
                    `nothing and an operator could have written it by hand`);
  }
  if (!ev.extractionPresent) {
    ev.reasons.push(`${relTxt} is absent; the verdict reads the canary through this file only`);
  }
  if (!ev.rawPresent || !ev.extractionPresent) return ev;
  // run.sh's extraction, re-run here: `grep -E 'NT_CANARY_'` over the dump.
  const rawText = fs.readFileSync(fRaw, "utf8");
  const rawAll = rawText.split("\n");
  ev.rawLines = rawAll.filter((l) => l !== "").length;
  const want = rawAll.filter((l) => l !== "" && /NT_CANARY_/.test(l));
  const got = fs.readFileSync(fTxt, "utf8").split("\n").filter((l) => l !== "");
  ev.rawMarkerLines = want.length;
  ev.extractionLines = got.length;
  const wantSet = new Map();
  for (const l of want) wantSet.set(l, (wantSet.get(l) || 0) + 1);
  for (const l of got) {
    const n = wantSet.get(l) || 0;
    if (n > 0) wantSet.set(l, n - 1); else ev.onlyInExtraction.push(l);
  }
  for (const [l, n] of wantSet) for (let i = 0; i < n; i++) ev.onlyInRawDump.push(l);
  const sameOrder = want.length === got.length && want.every((l, i) => l === got[i]);
  ev.agrees = sameOrder && ev.onlyInRawDump.length === 0 && ev.onlyInExtraction.length === 0;
  const excerpt = (ls) => ls.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 160))).join("; ") +
    (ls.length > 3 ? `; …and ${ls.length - 3} more` : "");
  if (ev.onlyInRawDump.length) {
    ev.reasons.push(`${ev.onlyInRawDump.length} NT_CANARY_ line(s) are in ${relRaw} and NOT in ${relTxt}, ` +
                    `which is the ONLY file the verdict reads the canary through — so the sensor recorded ` +
                    `them and every noVaultCall row was decided as though it had not [${excerpt(ev.onlyInRawDump)}]`);
  }
  if (ev.onlyInExtraction.length) {
    ev.reasons.push(`${ev.onlyInExtraction.length} line(s) are in ${relTxt} and NOT in ${relRaw}, so the file ` +
                    `the verdict reads is not the extraction run.sh made from the sensor's dump ` +
                    `[${excerpt(ev.onlyInExtraction)}]`);
  }
  if (!sameOrder && !ev.onlyInRawDump.length && !ev.onlyInExtraction.length) {
    ev.reasons.push(`${relTxt} holds the same ${got.length} line(s) as re-extracting ${relRaw} but in a ` +
                    `different order; grep preserves file order, so this file was rewritten`);
  }
  /* NON-VACUITY. An empty dump would make the comparison above trivially true,
   * which is the same defect as an empty snapshot digesting to a constant. A
   * genuine run always writes at least the three NT_CANARY_HIT_* counters and
   * NT_CANARY_ARMED_FINAL. */
  if (ev.rawMarkerLines === 0) {
    ev.reasons.push(`${relRaw} holds ${ev.rawLines} line(s) and NOT ONE of them carries an NT_CANARY_ marker; ` +
                    `the agreement between it and ${relTxt} would then be an agreement between two empty sets`);
  }
  ev.satisfied = ev.reasons.length === 0;
  return ev;
}

/* -- §8b/§8b2: the sensor armed, and the canary did not change behaviour ---
 * `canary-arm-<gen>.txt` must say CANARY_ARMED=yes, and the FIDELITY
 * comparison — the same three wrapper calls before and after the canary is
 * installed must have the same observable outcome — is recomputed here from
 * the two artefacts rather than believed because run.sh printed `ok`. The
 * baseline is additionally required to equal the outcome this checkout
 * records in sql/expected-baseline.<gen>.txt, which TRUSTED_DIGEST covers, so
 * the pair cannot agree with each other while both being wrong. */
function deriveArmControl(schema) {
  const relArmTxt = `canary-arm-${schema}.txt`;
  const relArmOut = `sql/arm-${schema}.out`;
  const relBase = `sql/baseline-${schema}.out`;
  const relExp = `sql/expected-baseline.${schema}.txt`;
  const ev = {
    satisfied: false, reasons: [], derivedFrom: [relArmTxt, relArmOut, relBase],
    armedYes: false, armOutcome: null, baselineOutcome: null,
    fidelityHolds: null, baselineMatchesCheckout: null,
    armTxtAgreesWithArmOut: null,
  };
  const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  const armTxt = readIf(path.join(O.out, relArmTxt));
  const armOut = readIf(path.join(O.out, relArmOut));
  const baseOut = readIf(path.join(O.out, relBase));
  const expTxt = readIf(path.join(CANARY_ROOT, relExp));
  if (armTxt === null) {
    ev.reasons.push(`${relArmTxt} is absent; nothing in this directory records that the canary fired ` +
                    `when it was called, so a zero canary count is an absence from an unproven detector`);
  } else {
    ev.armedYes = armTxt.split("\n").some((l) => l.trim() === "CANARY_ARMED=yes");
    if (!ev.armedYes) {
      ev.reasons.push(`${relArmTxt} does not record CANARY_ARMED=yes`);
    }
  }
  const line = (text, prefix) => {
    if (text === null) return null;
    for (const l of text.split("\n")) if (l.startsWith(prefix)) return l.slice(prefix.length).trim();
    return null;
  };
  ev.armOutcome = line(armOut, "ARMING_OUTCOME=");
  ev.baselineOutcome = line(baseOut, "BASELINE_OUTCOME=");
  if (armOut === null) ev.reasons.push(`${relArmOut} is absent; the arming probe's own output was not kept`);
  else if (ev.armOutcome === null) ev.reasons.push(`${relArmOut} carries no ARMING_OUTCOME= line`);
  if (baseOut === null) ev.reasons.push(`${relBase} is absent; the pre-canary baseline the fidelity control compares against was not kept`);
  else if (ev.baselineOutcome === null) ev.reasons.push(`${relBase} carries no BASELINE_OUTCOME= line`);
  if (ev.armOutcome !== null && ev.baselineOutcome !== null) {
    ev.fidelityHolds = ev.armOutcome === ev.baselineOutcome;
    if (!ev.fidelityHolds) {
      ev.reasons.push(`the canary CHANGED what the wrappers do on ${schema}: before '${ev.baselineOutcome}', ` +
                      `after '${ev.armOutcome}'; the delegate is not the original and no cell's outcome on ` +
                      `this generation is the schema's own behaviour`);
    }
  }
  if (ev.baselineOutcome !== null) {
    if (expTxt === null) {
      ev.reasons.push(`this checkout records no ${relExp}, so the observed baseline is compared with nothing`);
    } else {
      const want = expTxt.replace(/\r/g, "").split("\n")[0].replace(/^BASELINE_OUTCOME=/, "").trim();
      ev.baselineMatchesCheckout = ev.baselineOutcome === want;
      if (!ev.baselineMatchesCheckout) {
        ev.reasons.push(`the ${schema} baseline observed in ${relBase} is '${ev.baselineOutcome}' but this ` +
                        `checkout records '${want}' in ${relExp}`);
      }
    }
  }
  /* `canary-arm-<gen>.txt` is run.sh's grep of `arm-<gen>.out`. Re-derived, so
   * that the summary and the thing it summarises cannot drift apart. */
  if (armTxt !== null && armOut !== null) {
    const want = armOut.split("\n").filter((l) => /^CANARY_(ARMED|BASELINE|ROWS_AFTER_ARM)=/.test(l));
    const got = armTxt.split("\n").filter((l) => l !== "");
    ev.armTxtAgreesWithArmOut = want.length === got.length && want.every((l, i) => l === got[i]);
    if (!ev.armTxtAgreesWithArmOut) {
      ev.reasons.push(`${relArmTxt} holds ${got.length} verdict line(s) but re-extracting them from ` +
                      `${relArmOut} yields ${want.length}; one of the two was edited after the probe ran`);
    }
  }
  ev.satisfied = ev.reasons.length === 0;
  return ev;
}

/* -- §5b: the applier stops on the first error, with the EXPECTED class -----
 * Every migration and every fixture in this run is applied with
 * ON_ERROR_STOP=1. If that were not in effect, a migration could fail in the
 * middle and the run would carry on against a half-built generation. The
 * control feeds psql `select 1; select 1/0; select 2;`.
 *
 * WHAT THE ARTEFACT CAN AND CANNOT SETTLE. `sql/on-error-stop-<gen>.err` is
 * psql's stderr; it can settle that the applier failed with the exact error
 * class, and that is what is asserted here. It cannot settle the applier's
 * EXIT STATUS, which is the half that distinguishes "stopped" from "reported
 * and carried on", because the status is not written into the artefact. That
 * assertion remains run.sh-process-only and is disclosed in the
 * `run-controls` scope statement rather than implied to be closed. */
function deriveOnErrorStopControl(schema) {
  const rel = `sql/on-error-stop-${schema}.err`;
  const ev = {
    satisfied: false, reasons: [], derivedFrom: [rel],
    present: false, expectedErrorClassPresent: false,
    exitStatusObservable: false,
  };
  const f = path.join(O.out, rel);
  if (!fs.existsSync(f)) {
    ev.reasons.push(`${rel} is absent; nothing records that a deliberately broken script was refused, ` +
                    `so 'the migrations applied cleanly' rests on an applier never shown to fail`);
    return ev;
  }
  ev.present = true;
  const text = fs.readFileSync(f, "utf8");
  ev.expectedErrorClassPresent = text.includes("division by zero");
  if (!ev.expectedErrorClassPresent) {
    ev.reasons.push(`${rel} does not name the expected failure class ('division by zero'); the applier ` +
                    `control either did not run or failed for some other reason, and "some non-zero exit" ` +
                    `is not a control`);
  }
  ev.satisfied = ev.reasons.length === 0;
  return ev;
}

/* -- §7c: the tombstone classification, bound to the pinned expectation -----
 * `tombstone-<gen>.txt` is the real catalogue classifier's answer for the
 * three instrumented wrappers on this generation. It is what makes 0008 and
 * 0023 mean "before" and "after": on 0008 the wrappers are LIVE_EXPECTED, on
 * 0023 INTENTIONALLY_TOMBSTONED, and this checkout pins which in
 * expected/tombstone-state.<gen>.txt. */
function deriveTombstoneControl(schema) {
  const rel = `tombstone-${schema}.txt`;
  const relExp = `expected/tombstone-state.${schema}.txt`;
  const ev = {
    satisfied: false, reasons: [], derivedFrom: [rel],
    present: false, classifierResult: null, requiredState: null,
    wrappersClassified: {}, wrappersMissing: [], agreesWithCheckout: null,
  };
  const f = path.join(O.out, rel);
  if (!fs.existsSync(f)) {
    ev.reasons.push(`${rel} is absent; this run kept no record of what the catalogue classifier said the ` +
                    `three instrumented wrappers were on generation ${schema}`);
    return ev;
  }
  ev.present = true;
  const text = fs.readFileSync(f, "utf8");
  const cls = text.split("\n").filter((l) => l.startsWith("CANARY_TOMBSTONED="))[0];
  const src = text.split("\n").filter((l) => l.startsWith("CANARY_TOMBSTONED_SOURCE="))[0];
  if (!cls) {
    ev.reasons.push(`${rel} carries no CANARY_TOMBSTONED= classification`);
  } else {
    for (const part of cls.slice("CANARY_TOMBSTONED=".length).split(",")) {
      const [k, v] = part.split("=");
      if (k && v) ev.wrappersClassified[k.trim()] = v.trim();
    }
    ev.wrappersMissing = INSTRUMENTED_WRAPPERS.filter((w) => !(w in ev.wrappersClassified));
    if (ev.wrappersMissing.length) {
      ev.reasons.push(`${rel} classifies ${Object.keys(ev.wrappersClassified).length} routine(s) and says ` +
                      `nothing about ${ev.wrappersMissing.join(", ")}`);
    }
  }
  if (src) {
    const m = /\|result=([A-Z]+)\|/.exec(src);
    ev.classifierResult = m ? m[1] : null;
    const r = /\|required=([A-Z_]+)\s*$/.exec(src.trim());
    ev.requiredState = r ? r[1] : null;
    if (ev.classifierResult !== "PASS") {
      ev.reasons.push(`${rel} records the classifier result as ${ev.classifierResult || "(unstated)"}, not PASS`);
    }
  } else {
    ev.reasons.push(`${rel} carries no CANARY_TOMBSTONED_SOURCE= line, so the classification is not bound ` +
                    `to the classifier that produced it`);
  }
  const expF = path.join(CANARY_ROOT, relExp);
  if (!fs.existsSync(expF)) {
    ev.reasons.push(`this checkout records no ${relExp}, so the classification is compared with nothing`);
  } else {
    const want = fs.readFileSync(expF, "utf8").replace(/\r/g, "").split("\n")[0].trim();
    const wrong = Object.entries(ev.wrappersClassified).filter(([, v]) => v !== want);
    ev.agreesWithCheckout = wrong.length === 0 && ev.wrappersMissing.length === 0 &&
      (ev.requiredState === null || ev.requiredState === want);
    if (!ev.agreesWithCheckout) {
      ev.reasons.push(`${relExp} pins '${want}' for generation ${schema} but ${rel} says ` +
                      `${wrong.length ? wrong.map(([k, v]) => `${k}=${v}`).join(", ") : `required=${ev.requiredState}`}`);
    }
  }
  ev.satisfied = ev.reasons.length === 0;
  return ev;
}

/* -- R7-3: the image's OWN STDOUT, which was collected and never opened -----
 * run.sh captures `docker logs <app container>` for each cell into
 * instr/<gen>-<cell>.applog. A literal scan of driver/ and tests/ for the
 * string "applog" found exactly one hit — the line that WRITES it. Nothing
 * read the other side. The same scan with canary-<gen>, pglog-hits-,
 * sink-<gen> and tombstone- as positive controls resolved all four to real
 * readers, so "not read" was an answer the scan could distinguish from "not
 * found". MEASURED: two lines appended to one cell's applog, one recording a
 * 200 OK from paper-api.alpaca.markets and one recording a successful
 * vault_create_secret rpc, certified rc=0 PASS.
 *
 * Collecting evidence and ignoring it is the exact shape observers.mjs names
 * as audit finding D, so the choice taken here is the first of the three the
 * finding offers: SCAN IT, and refuse on a hit.
 *
 * WHAT THE SCAN IS. Each driven cell must have an applog — an absent one is a
 * refusal, otherwise deleting them all restores "read by nothing" — and no
 * line of any applog may name a pinned broker host or one of the three
 * instrumented wrapper routines. `linesScanned` and `filesScanned` are
 * published as numbers, because "0 hits" is also what a scan that never ran
 * produces.
 *
 * WHAT IT IS NOT. It is a keyword scan over free text the image chose to
 * print, so it is a lower bound on anything and a proof of nothing: an image
 * that makes a broker call silently prints nothing, and the containment
 * claims do not rest on this. It is a tripwire over evidence that was already
 * being collected, and a frozen image whose boot banner legitimately named a
 * broker host would refuse here and have to be looked at. Measured on the
 * certifying set: all 48 applogs are the same 113-byte Next.js boot banner. */
function deriveApplogScan(schema, drivenIds) {
  const ev = {
    satisfied: false, reasons: [], derivedFrom: `instr/${schema}-<cell>.applog`,
    cellsExpected: drivenIds.length, filesScanned: 0, bytesScanned: 0, linesScanned: 0,
    missing: [], orphans: [], hits: [],
    needles: { brokerHosts: HARNESS_BROKER_HOSTS.length, wrappers: INSTRUMENTED_WRAPPERS.length },
  };
  const instrDir = path.join(O.out, "instr");
  const needles = [...HARNESS_BROKER_HOSTS, ...INSTRUMENTED_WRAPPERS];
  for (const id of drivenIds) {
    const rel = `instr/${schema}-${id}.applog`;
    const f = path.join(O.out, rel);
    if (!fs.existsSync(f)) { ev.missing.push(rel); continue; }
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); }
    catch (e) { ev.reasons.push(`${rel} cannot be read (${e.message})`); continue; }
    ev.filesScanned++;
    ev.bytesScanned += Buffer.byteLength(text, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "") continue;
      ev.linesScanned++;
      const hit = needles.filter((n) => lines[i].includes(n));
      if (hit.length && ev.hits.length < 40) {
        ev.hits.push({
          file: rel, lineNo: i + 1, matched: hit,
          excerpt: lines[i].length > 200 ? `${lines[i].slice(0, 197)}…` : lines[i],
        });
      } else if (hit.length) {
        ev.hits.push({ file: rel, lineNo: i + 1, matched: hit, excerpt: "(truncated: over 40 hits)" });
      }
    }
  }
  /* An applog for a cell no result in this verdict claims — the same question
   * ADV-1 asks of the instrument's JSONL logs. */
  let files = [];
  try { files = fs.readdirSync(instrDir); } catch { files = []; }
  const claimed = new Set(drivenIds);
  for (const f of files) {
    if (!f.startsWith(`${schema}-`) || !f.endsWith(".applog")) continue;
    const id = f.slice(`${schema}-`.length, -".applog".length);
    if (!claimed.has(id)) ev.orphans.push(`instr/${f}`);
  }
  if (ev.missing.length) {
    ev.reasons.push(`${ev.missing.length} of ${ev.cellsExpected} driven cell(s) on ${schema} have no applog ` +
                    `(first: ${ev.missing[0]}); the image's own stdout for those cells is not in this directory`);
  }
  if (ev.orphans.length) {
    ev.reasons.push(`${ev.orphans.length} applog(s) for generation ${schema} belong to no cell result in this ` +
                    `verdict (first: ${ev.orphans[0]})`);
  }
  if (ev.hits.length) {
    const h = ev.hits[0];
    ev.reasons.push(`${ev.hits.length} line(s) of the image's own stdout name a pinned broker host or an ` +
                    `instrumented wrapper (first: ${h.file}:${h.lineNo} matched ${h.matched.join(",")} — ` +
                    `${JSON.stringify(h.excerpt)}); the image printed a record of doing the thing this run ` +
                    `certifies it did not do`);
  }
  ev.satisfied = ev.reasons.length === 0;
  return ev;
}

/* -- R9-2: THE IMAGE / SOURCE / COMMIT BINDING, RE-DERIVED HERE ------------
 *
 * `run.sh` computes three digests before it drives anything (see
 * lib-source-digest.sh, audit finding B7): the content digest of --source, the
 * digest stamped on the image at build time as org.nt.canary.source-digest,
 * and the digest of the tree `git` reports at --target-sha. It requires all
 * three to be equal, and it requires the image's
 * org.opencontainers.image.revision label to be --target-sha. It writes all
 * five values into provenance.json.
 *
 * NOTHING READ THEM AGAIN. A literal scan of driver/ for `sourceDigest`,
 * `commitTreeDigest`, `imageSourceDigest`, `imageRevision` and `targetSha`
 * returned ZERO hits, while `provenance.json` itself returned twelve — so the
 * file was read, and those fields of it were not. MEASURED against the shipped
 * code over a genuine 48-cell certifying corpus, four separate edits of
 * provenance.json alone:
 *
 *   sourceDigest      != commitTreeDigest   -> rc=0 PASS
 *   imageSourceDigest != sourceDigest       -> rc=0 PASS
 *   imageRevision     != targetSha          -> rc=0 PASS
 *   all three inconsistent at once          -> rc=0 PASS
 *
 * every one of them with the full banner and hardFailures 0, while the scope
 * document printed underneath said "A PASS is a statement about one image,
 * built from one source tree, bound to one commit". That is the R7-4 shape —
 * a control asserted inside run.sh's process and read by nothing at verdict
 * time — one artefact along, and re-verification of a stored directory is the
 * mode every test in tests/ uses.
 *
 * WHAT THIS BUYS AND WHAT IT DOES NOT. provenance.json is written by the
 * driver, so this is not an independent attestation of the binding; it is the
 * same tamper-evidence the pathClass and gateway-kind cross-checks are — a
 * record that contradicts itself is refused rather than believed in either
 * direction, and the fields must be PRESENT, so their absence is a refusal and
 * not a silence. An operator who edits all five consistently is inside the
 * artefact-forgery limit and it says so. */
function deriveImageSourceBinding() {
  const ev = {
    satisfied: false, reasons: [], derivedFrom: "provenance.json",
    sourceDigest: null, commitTreeDigest: null, imageSourceDigest: null,
    imageRevision: null, targetSha: null, targetDirty: null,
    sourceEqualsCommit: null, imageEqualsSource: null, revisionEqualsTargetSha: null,
  };
  if (!PROV) {
    ev.reasons.push("there is no provenance.json, so the image/source/commit binding run.sh computed " +
                    "before driving cannot be re-derived at all");
    return ev;
  }
  const HEX64 = /^[0-9a-f]{64}$/;
  const HEX40 = /^[0-9a-f]{40}$/;
  for (const [k, re] of [["sourceDigest", HEX64], ["commitTreeDigest", HEX64],
                         ["imageSourceDigest", HEX64], ["imageRevision", HEX40], ["targetSha", HEX40]]) {
    const v = PROV[k];
    ev[k] = typeof v === "string" ? v : null;
    if (typeof v !== "string" || !re.test(v)) {
      ev.reasons.push(`provenance.json ${k} is ${JSON.stringify(v)}, which is not the digest shape run.sh ` +
                      `writes; the binding cannot be checked from a record that does not carry it`);
    }
  }
  ev.targetDirty = PROV.targetDirty;
  if (ev.reasons.length) return ev;
  ev.sourceEqualsCommit = ev.sourceDigest === ev.commitTreeDigest;
  ev.imageEqualsSource = ev.imageSourceDigest === ev.sourceDigest;
  ev.revisionEqualsTargetSha = ev.imageRevision === ev.targetSha;
  if (!ev.sourceEqualsCommit) {
    ev.reasons.push(`the --source tree this run enumerated digests to ${ev.sourceDigest} but the tree at ` +
                    `--target-sha ${ev.targetSha} digests to ${ev.commitTreeDigest}; the run drove a surface ` +
                    `that is not the commit's`);
  }
  if (!ev.imageEqualsSource) {
    ev.reasons.push(`the image was built from a tree digesting to ${ev.imageSourceDigest} but --source ` +
                    `digests to ${ev.sourceDigest}; the image under test is not the tree whose routes were driven`);
  }
  if (!ev.revisionEqualsTargetSha) {
    ev.reasons.push(`the image is labelled org.opencontainers.image.revision=${ev.imageRevision} but this ` +
                    `verdict is filed against --target-sha ${ev.targetSha}`);
  }
  ev.satisfied = ev.reasons.length === 0;
  return ev;
}

{
  console.log("");
  const binding = deriveImageSourceBinding();
  controlEvidence.imageSourceBinding = binding;
  console.log(`   B7 image/source/commit        : ${binding.satisfied ? "satisfied" : "NOT SATISFIED"} ` +
              `(source==commit ${binding.sourceEqualsCommit}, image==source ${binding.imageEqualsSource}, ` +
              `revision==target-sha ${binding.revisionEqualsTargetSha}, targetDirty ${binding.targetDirty})`);
  const egress = deriveEgressControl();
  controlEvidence.egressClassifier = egress;
  console.log(`   §3c egress classifier         : ${egress.satisfied ? "satisfied" : "NOT SATISFIED"} ` +
              `(${egress.brokerClassifiedNamingABrokerHost} broker-classified naming a broker host, ` +
              `${egress.sinkClassifiedNamingTheGateway} sink-classified naming the gateway, ` +
              `${egress.gatewayNamedButClassifiedBroker} gateway-named-but-broker)`);

  controlEvidence.perSchema = {};
  for (const schema of O.schemas) {
    let drivenIds = [];
    try {
      drivenIds = fs.readdirSync(path.join(O.out, "cells"))
        .filter((f) => f.startsWith(`result-${schema}-`) && f.endsWith(".json"))
        .map((f) => f.slice(`result-${schema}-`.length, -".json".length));
    } catch { drivenIds = []; }
    const per = {
      arming: deriveArmControl(schema),
      onErrorStop: deriveOnErrorStopControl(schema),
      tombstoneClassification: deriveTombstoneControl(schema),
      applogScan: deriveApplogScan(schema, drivenIds),
      canaryExtraction: deriveCanaryExtractionControl(schema),
    };
    controlEvidence.perSchema[schema] = per;
    console.log(`   §8b/§5b/§7c ${schema.padEnd(6)}          : armed=${per.arming.armedYes} ` +
                `fidelity=${per.arming.fidelityHolds} onErrorStop=${per.onErrorStop.expectedErrorClassPresent} ` +
                `tombstone=${per.tombstoneClassification.agreesWithCheckout}`);
    console.log(`   image stdout scanned ${schema.padEnd(6)} : ${per.applogScan.filesScanned} applog(s), ` +
                `${per.applogScan.linesScanned} line(s), ${per.applogScan.bytesScanned} bytes, ` +
                `${per.applogScan.hits.length} hit(s)`);
    console.log(`   §11 canary extraction ${schema.padEnd(6)}: ${per.canaryExtraction.agrees === true ? "agrees" : "DOES NOT AGREE"} ` +
                `(sql/canary-dump-${schema}.out: ${per.canaryExtraction.rawMarkerLines} NT_CANARY_ line(s) of ` +
                `${per.canaryExtraction.rawLines}; canary-${schema}.txt: ${per.canaryExtraction.extractionLines}` +
                `${per.canaryExtraction.onlyInRawDump.length ? `, ${per.canaryExtraction.onlyInRawDump.length} ONLY IN THE DUMP` : ""}` +
                `${per.canaryExtraction.onlyInExtraction.length ? `, ${per.canaryExtraction.onlyInExtraction.length} ONLY IN THE EXTRACTION` : ""})`);
  }

  /* Only a CERTIFYING manifest is refused for these. The k2 fixture stacks
   * drive synthetic cells with no database, no control container and no
   * applogs at all; refusing them here would make a fixture's absence look
   * like a control failure, and a fixture can never print PASS anyway. */
  if (CERTIFYING) {
    for (const r of binding.reasons) hard(`control B7 (image/source/commit binding): ${r}`);
    for (const r of egress.reasons) hard(`control §3c (egress classifier): ${r}`);
    for (const schema of O.schemas) {
      const per = controlEvidence.perSchema[schema];
      for (const r of per.arming.reasons) hard(`control §8b/§8b2 (${schema} arming/fidelity): ${r}`);
      for (const r of per.onErrorStop.reasons) hard(`control §5b (${schema} ON_ERROR_STOP): ${r}`);
      for (const r of per.tombstoneClassification.reasons) hard(`control §7c (${schema} tombstone): ${r}`);
      for (const r of per.applogScan.reasons) hard(`image stdout (${schema} applog scan): ${r}`);
      for (const r of per.canaryExtraction.reasons) hard(`control §11 (${schema} canary extraction): ${r}`);
    }
  }
}

/* -- the generation axis, checked ACROSS generations ----------------------- */
if (CERTIFYING) {
  console.log("");
  for (const schema of O.schemas) {
    const fps = [...(observedWitnesses.get(schema) || [])];
    console.log(`   generation witness ${schema.padEnd(6)}: ${fps.join(", ") || "(none observed)"}`);
    if (fps.length > 1) {
      hard(`schema ${schema}: the cells of one generation were driven against ${fps.length} different databases ` +
           `(${fps.join(", ")}); a generation is one database, not a filename prefix`);
    }
  }
  // Two generations that observed the SAME database are one generation driven
  // twice. This is the check a wholesale swap of the two sets cannot survive
  // together with the per-cell pin above.
  const pairs = [];
  for (let i = 0; i < O.schemas.length; i++) {
    for (let j = i + 1; j < O.schemas.length; j++) {
      const a = [...(observedWitnesses.get(O.schemas[i]) || [])];
      const b = [...(observedWitnesses.get(O.schemas[j]) || [])];
      const shared = a.filter((x) => b.includes(x));
      if (shared.length) pairs.push(`${O.schemas[i]} and ${O.schemas[j]} both observed ${shared.join(",")}`);
    }
  }
  if (pairs.length) {
    hard(`the migration generations are not distinct databases: ${pairs.join("; ")}`);
  }
  if (observedRunNonces.size > 1) {
    hard(`the artefact directory holds cells from ${observedRunNonces.size} different runs ` +
         `(${[...observedRunNonces].join(", ")}); a verdict is over one run`);
  }
  if (PROV) {
    const provSchemas = Array.isArray(PROV.schemas) ? PROV.schemas : [];
    const notRun = O.schemas.filter((s) => !provSchemas.includes(s));
    if (notRun.length) {
      hard(`--schemas names ${notRun.join(",")}, which provenance.json says this run never drove ` +
           `(it drove ${provSchemas.join(",") || "nothing"})`);
    }
    console.log(`   run nonce                     : ${PROV.runNonce}`);
    console.log(`   image under test (provenance) : ${PROV.image} ${PROV.imageId || ""}`);
  }
}

/* -- WHAT THIS VERDICT DOES NOT SAY ----------------------------------------
 * Every previous round of this harness was broken by a reader taking a PASS to
 * mean more than it did, so the limits are now part of the output rather than
 * part of the prose someone may not have read. They are written to
 * `$OUT/verdict-scope.json` on every exit path FROM THE VERDICT STAGE — pass,
 * partial, finding and refusal alike — and printed with the banner. The paths
 * that skip it are the ones that die before a verdict can be attempted at all
 * (an unreadable manifest, an absent provenance record); those print their own
 * reason and nothing else.
 *
 * Some of these are inherent to the mechanism and cannot be closed by a better
 * check: a canary over three named routines cannot see a fourth, and no gate
 * over an artefact directory can defend against an operator who rewrites the
 * artefacts. Those are marked `inherent`.
 */
function scopeStatements() {
  const wrappersReached = {};
  for (const s of summary) {
    if (!s.perWrapperMatrix) continue;
    for (const [fn, n] of Object.entries(s.perWrapperMatrix)) {
      wrappersReached[fn] = (wrappersReached[fn] || 0) + n;
    }
  }
  return [
    {
      id: "instrumented-routines",
      inherent: true,
      statement:
        "The canary instruments exactly public.vault_create_secret, public.vault_update_secret and " +
        "public.vault_delete_secret. A Vault write that does not go through one of those three — for " +
        "example a new SECURITY DEFINER routine calling vault.create_secret directly — moves none of " +
        "these counters. A zero here means 'the image did not call these three routines', NOT 'no Vault " +
        "write is reachable'. A signature-keyed sensor cannot enumerate names that do not exist yet.",
    },
    {
      id: "tombstone-set",
      inherent: false,
      statement:
        "Migration 0022 tombstones more routines than the three instrumented here — six, one " +
        "of them (public.resolve_create_operation(uuid,uuid)) written inline in section 2 rather than in " +
        "section 5's loop — and 0017 tombstones two more by the same mechanism, eight in all. This " +
        "harness instruments the three the frozen image's credentials path could reach. NOTHING IN " +
        "runtime-canary/ COVERS THE OTHER FIVE: their completeness is the catalogue classifier's " +
        "control. That classifier's derivation was found section-scoped by an audit and has since been " +
        "widened to the union of both shim mechanisms over the whole migration set, with an expectation " +
        "row, a verdict and a mutant for each of the eight — but that is ITS evidence, not this PASS's. " +
        "This PASS says nothing about them.",
    },
    {
      id: "driven-surface",
      inherent: false,
      statement:
        "The driven surface is every exported POST/PUT/PATCH/DELETE under app/api, enumerated from the " +
        "source tree. Next Server Actions are NOT enumerated and NOT driven here; they are covered " +
        "statically in the bridge checkout by dashboard/test/containment/server-actions.test.ts, which " +
        "is weaker evidence than this executed proof.",
    },
    {
      id: "property-b-reach",
      inherent: false,
      statement:
        Object.keys(wrappersReached).length
          ? "Matrix-attributed canary hits per wrapper in this run: " +
            JSON.stringify(wrappersReached) +
            ". A wrapper with zero has NOT been shown end-to-end reachable through the driven surface; " +
            "for those, the sensor's liveness rests on the trusted runner's synthetic challenges only."
          : "This run made no matrix-attributed canary hits, so it demonstrates nothing about which " +
            "wrappers the driven surface can reach. That is what --mode mutant is for.",
    },
    {
      id: "artefact-forgery",
      inherent: true,
      statement:
        "THE ARTEFACT SET IS NOT FORGERY-PROOF, AND CANNOT BE MADE SO. Three containers write the " +
        "evidence: the driver writes cells/, the recording gateway writes sink-<schema>.jsonl, the image " +
        "under test writes instr/. Every cell identity, every generation witness, every request " +
        "observation and every in-process claim is cross-checked against a file the driver did not " +
        "write. That raises the COST of a forgery from local to consistent; it does not make one " +
        "impossible, and an operator with write access to all three logs defeats it. MEASURED, by an " +
        "auditor, against this exact code: the C attack (one cell's request observations pasted into " +
        "twenty-three others) is restored by 9 further lines, and the B attack (one generation's 24 " +
        "results filed under the other's names) by 14, in both cases by importing this harness's own " +
        "driver/observation.mjs and rewriting the SECOND observer — the gateway's log — to agree. That " +
        "is not a defect anyone can close from inside this harness: the gateway's log is a file on the " +
        "host, and nothing here has authority over a host filesystem. Any statement that this artefact " +
        "set resists forgery, rather than resisting a forgery confined to one file, is false. Nor does " +
        "any of this constrain the driver at RUN time — it originates the observations it attests. " +
        "WHAT THE 9, 14 AND 15-LINE FIGURES ARE, AND ARE NOT (R7-5). They are the cost of RESTORING " +
        "three specific attacks — C, B, and the sensor-seal forgery — CONSISTENTLY, once each was " +
        "refused. They are not a floor for artefact edits in general, and reading them as one is the " +
        "mistake this paragraph used to invite by claiming that what is closed is 'artefact " +
        "directories edited afterwards by someone who edits only part of them, and nothing else'. " +
        "That sentence was false, and a ONE-BYTE partial edit falsified it. MEASURED, four runs over " +
        "one genuine 48-cell set: a POST to paper-api.alpaca.markets appended to the IMAGE'S OWN " +
        "LOG inside a request window — the file this harness exists to read, no other file touched " +
        "— was refused (rc=3, 'the IMAGE'S OWN LOG records 1 event in this request's window that " +
        "the cell result does not report'). Flipping the single leading '{' of that line to 'x' " +
        "made it unparseable, every reader skipped it in silence, and the same directory certified: " +
        "rc=0, PASS, hardFailures 0. Hiding a recorded broker call cost one byte. THAT ONE IS NOW " +
        "CLOSED by the round-7 unparseable-line refusal — every physical line of the instrument " +
        "logs and of the gateway log must parse, and one that does not is named with its file, its " +
        "line number and the parser's own message — and the same one-byte directory now refuses " +
        "(rc=3) naming instr/0008-m-off__s-off__b-probe.jsonl:14. So the honest " +
        "statement of the boundary is: a partial edit of the artefact directory is DETECTED where " +
        "the edited file is cross-checked against a file the driver did not write, and where the " +
        "edit leaves the file parseable or unparseable — both are now refusals. It is NOT detected " +
        "when every observer of the same fact is edited to agree, which is what the 9/14/15-line " +
        "measurements cost. No enumeration of partial edits here is a proof that the next one is " +
        "covered; only the cross-check that fires is evidence, and the cross-checks are named " +
        "one by one in claimEvidence and controlEvidence rather than summarised as a property.",
    },
    {
      id: "sensor-report-authenticity",
      inherent: true,
      statement:
        "The sensor verdict is derived from sensor-state-<schema>/report-body.txt, HMAC-SHA256-sealed " +
        "with the 256-bit key verify-sensor.sh draws from /dev/urandom at `arm`, and this verdict " +
        "re-verifies that seal, the run manifest's seal, and every challenge-ledger line's MAC under the " +
        "same key before believing any of them. That closes the measured attack: deleting every " +
        "trusted-runner artefact and typing eight lines of plain text into sensor-report-<schema>.txt " +
        "produced a full certifying PASS with scope recording derived:TRUSTWORTHY, manifestVerified:true. " +
        "WHAT IT DOES NOT CLOSE: the key is written into the artefact directory, because a " +
        "re-verification of an existing directory must be able to check the seal and a key destroyed at " +
        "the end of the run would make every later re-verification refuse. So an operator who holds the " +
        "directory holds the key. MEASURED: turning a genuinely UNTRUSTWORTHY sealed run into a " +
        "TRUSTWORTHY one — body, seal, text file, manifest MAC and all twelve ledger line MACs, " +
        "consistently — costs 15 executable lines of node and produces a full certifying PASS. This is " +
        "tamper-evidence against a partial edit, not a signature.",
    },
    {
      id: "in-process-claim-derivation",
      inherent: false,
      statement:
        "noBodyParse, noSupabaseClient, noBrokerCall, noDatabaseCall, noUnexpectedNetworkCall, noAuthCall " +
        "and noPostgRESTCall are decided from $OUT/instr/<schema>-<cell>.jsonl — the log the IMAGE UNDER " +
        "TEST appends to a host bind mount — over request windows taken from the recording gateway's own " +
        "log. They used to be decided from results[].events, the DRIVER'S TRANSCRIPTION of those events, " +
        "with the instrument's file read only for the presence of an instrument.loaded line: an audit " +
        "appended a body.parse and a fetch to paper-api.alpaca.markets inside a request window, changed " +
        "nothing else, and got PASS with 'noBodyParse: 480 satisfied, 0 violated'. Both copies are still " +
        "read and any difference between them is a hard failure. THE WINDOWS COVER ONLY THE REQUESTS: " +
        "measured on the certifying set, a cell's ten request windows span about 11% of its gateway " +
        "timeline, the rest being the driver's own #witness and #idle bookends — and the same auditor " +
        "then moved the same events 742 ms past the last window and got the PASS back. So every line of " +
        "instr/<schema>-<cell>.jsonl must now be ATTRIBUTED, to the boot snapshot the cell result " +
        "declares or to exactly one bounded request window, and an unattributed line is a refusal " +
        "(claimEvidence.eventsUnattributed above). Unattributed is not absent. THAT WAS TRUE ONLY OF " +
        "PARSEABLE LINES until round 7: attribution ran over the rows JSON.parse returned, so a line " +
        "that did not parse was in no bucket, counted in no denominator, and therefore ABSENT — one " +
        "byte flipped in a recorded broker call hid it. Every physical line of every instrument log " +
        "and of the gateway log must now parse; an unparseable line is refused by file, physical " +
        "line number and the parser's own message, and the raw line count is published beside the " +
        "parsed one so the two denominators can be compared by hand. TWO INPUTS REMAIN " +
        "DRIVER-ONLY and are not observable from any other file: the V8 coverage markers (markDelta, " +
        "which contribute to noSupabaseClient and noBrokerCall alongside the events) and routeExec " +
        "(handlerNotReached). They are read over the instrument's control surface and never written to " +
        "the bind mount, so for those two the driver's reading is the only reading. " +
        "THREE LIMITS OF THE ATTRIBUTION ITSELF, stated because they are refusal-shaped and a future red " +
        "must not be mistaken for an attack. (1) It is UNMEASURED under --mode mutant: no mutant image " +
        "exists at this sha, so the only sets it has been measured on are frozen, where the in-window " +
        "bucket is empty. A mutant image that emits an event outside every request window WILL refuse. " +
        "That is the harness saying it cannot attribute the event, which is the correct direction, but " +
        "the false-positive rate for a real mutant run has not been observed. (2) The driver snapshots " +
        "the boot events, then reads /env, then POSTs the first cell tag; an event emitted in that gap " +
        "is in neither bucket and refuses. Measured 0 across five real runs, four 48-cell and one " +
        "1-cell. (3) The unclaimed-log scan covers instr/<schema>-<cell>.jsonl only. A planted log under " +
        "any other name is not scanned — and also feeds no claim. " +
        "ROUND 5 BROKE THE ABOVE IN THREE PLACES AND THEY ARE NOW CLOSED; the reds are recorded here " +
        "because each was a full certifying PASS over artefacts recording a real violation. " +
        "(a) The boot-bucket judge was a DENY-list of four network kinds — fetch, socket.connect, " +
        "tls.connect, dns.lookup — while instrument.cjs also emits node:{http,https}.{request,get}, " +
        "which claims.mjs has always counted as egress; a POST to paper-api.alpaca.markets recorded " +
        "under node:https.request was attributed to boot and judged by nothing. It also read " +
        "detail.hostClass, a field whoever writes the record chooses, so relabelling a broker fetch " +
        "'loopback' passed too. The judge is now an ALLOW-list of the kinds a boot snapshot may contain " +
        "(instrument.loaded/ready/coverage/error, env.read) and consults no self-reported class: an " +
        "unrecognised kind refuses. (b) THE SECOND OBSERVER HAD THE SAME UNREAD COMPLEMENT. The " +
        "recording gateway's log was read only as sinkMap.get(<cell>#<n>), so a GET /rest/v1/accounts " +
        "and a GET /auth/v1/user logged under one cell's #idle tag — no instrument event, no cell " +
        "result touched — certified. Every gateway entry that is not the harness's own /__canary " +
        "traffic must now fall under a request tag some cell result claims " +
        "(claimEvidence.gatewayRowsUnaccounted above; measured 0 of 3960 across four genuine runs, all " +
        "frozen — like the instrument-log attribution it is UNMEASURED under --mode mutant, because no " +
        "mutant image exists at this sha, and a mutant that talks to the sink at container start will " +
        "refuse rather than report a FINDING; that is the correct direction but the false-positive rate " +
        "has not been observed). The harness-control exemption is derived from the request path, not read " +
        "off the row, so a data-plane entry cannot claim it by calling itself 'harness'. " +
        "THAT LAST SENTENCE WAS TRUE OF THE EXEMPTION AND FALSE OF THE DECISION UNTIL ROUND 8, and the " +
        "prose here said the opposite: it told the reader that an entry under a REQUEST tag IS seen by " +
        "noAuthCall, noPostgRESTCall and noDatabaseCall 'because those are decided per request'. It was " +
        "seen only if it LABELLED ITSELF. Those three claims filtered the gateway's rows on the row's own " +
        "`kind` field, so deleting that one field from one line of sink-<gen>.jsonl — the line rewritten " +
        "in place to record GET /rest/v1/accounts?select=* -> 200 under the claimed request tag " +
        "m-off__s-off__b-probe#3, same 555 non-empty lines before and after — turned rc=1 FINDING " +
        "(noPostgRESTCall and noDatabaseCall violated, with 'kind':'postgrest' present) into rc=0, PASS " +
        "banner, hardFailures 0, noPostgRESTCall 480 satisfied / 0 violated. The verdict had already " +
        "DERIVED the right class and PUBLISHED the consequence — gatewayHarnessRows 555->554 and " +
        "gatewayRowsInAClaimedRequest 0->1, and that second number is 0 on every genuine frozen run — and " +
        "then decided the claim from the label the row no longer carried. It computed the truth and " +
        "consulted the lie. Since round 8 there is ONE classifier (claims.mjs classifyGatewayPath), the " +
        "class of every gateway row is derived from its path for the attribution AND for every claim, " +
        "and no filter in claims.mjs reads `kind` at all; see the data-plane-surface entry below for " +
        "which class each claim reads. A row whose declared kind contradicts its path is refused as " +
        "self-contradicting, and a row carrying no kind at all is judged exactly as if it had labelled " +
        "itself honestly (count published as claimEvidence.gatewayRowsWithoutADeclaredKind). " +
        "WHAT THE FOUR CORPORA BEHIND THESE AGGREGATES ARE, DISCLOSED (R7-5). The 1920 windows, " +
        "2385 log events, 3960 gateway rows and the 10.8% / 11.7% window-coverage figures all come " +
        "from four genuine 48-cell runs still on the machine that produced them: run nonces " +
        "7da1ca7f…, 21e6a343…, 55c8d4d3… and 3085a474…. RE-MEASURED for this round, every one of " +
        "the four is at request-attestation OBSERVATION_VERSION 1 or older: the first three carry " +
        "version 1 (1110 gateway rows each, of which 480 are /__canary/observe) and 3085a474 " +
        "carries NO request attestation at all (630 rows, 0 observe rows — it predates the " +
        "attestation entirely). 3 x 1110 + 630 = 3960, so the total is right, but the per-run " +
        "gloss '480 observe rows per pair of generations' holds for three of the four and not for " +
        "the fourth. Version 1 is the version tests/run-all.sh and tests/k14 now REFUSE as " +
        "non-forward-portable, so NONE of the four directories these numbers were measured on could " +
        "be re-verified by the harness as it stands; they are historical measurements of an earlier " +
        "attestation, not results this checkout can reproduce on demand. Reproducing them requires " +
        "driving fresh matrices at version 2. " +
        "(c) BOTH cross-checks over the events keyed on (seq, t, kind) — observers.mjs eventKey and " +
        "observation.mjs eventDigest_16 — leaving each event's detail, i.e. the host, port and path " +
        "class every claim actually reads, bound by nothing; rewriting only the detail in both " +
        "instrument-side copies turned a measured noBrokerCall=violated into a PASS. The attested " +
        "identity now covers a canonical digest of the detail, which is why the observation version is " +
        "2 and why an artefact directory produced before that bump refuses instead of certifying.",
    },
    {
      id: "data-plane-surface",
      inherent: false,
      statement:
        "WHAT COUNTS AS 'THE DATA PLANE', AND WHICH CLAIM READS EACH PART OF IT. Until round 8 the " +
        "answer was TWO PATH PREFIXES. sink.mjs classify(), instrument.cjs classifyPath() and " +
        "observers.mjs classifyGatewayPath() all returned 'other' for /storage/v1, /graphql/v1, " +
        "/realtime/v1 and /functions/v1; NO CLAIM READ 'other' ON EITHER OBSERVER; and " +
        "noUnexpectedNetworkCall permits anything addressed to the gateway host, because the gateway " +
        "host is in ALLOWED_HOST_CLASSES. MEASURED by driving buildClaims directly with every sensor " +
        "live: /rest/v1/accounts and /auth/v1/user violate their claims (the controls fire), while a " +
        "storage read of /storage/v1/object/private/broker-keys.json, a /graphql/v1 query, a " +
        "/realtime/v1/websocket upgrade and a /functions/v1/place-order invocation each produced 16 of " +
        "16 records ALL SATISFIED. End to end, a gateway row on any of them — with the self-consistent " +
        "\"kind\":\"other\" BOTH observers would honestly write for it — certified. Those are exactly " +
        "the surfaces the Stage 2 edge exists to deny, and the canary was not watching them: a coverage " +
        "hole, not a forgery. " +
        "THE CLASSIFICATION IS NOW TOTAL AND EVERY CLASS IS READ. classifyGatewayPath lives in " +
        "claims.mjs and is the only copy; sink.mjs and instrument.cjs run the same table so their " +
        "records are self-consistent, but neither of their answers decides anything. The classes and " +
        "their readers, generated from GATEWAY_CLASS_READERS rather than written out here so the two " +
        "cannot drift: " +
        GATEWAY_PATH_CLASSES.map((c) => {
          const rs = GATEWAY_CLASS_READERS[c];
          return `${c} -> ${rs.length ? rs.join(" + ") : "no claim reads it, and since round 9 no row is " +
            "exempt merely for being on that path: every /__canary row must match the driver's protocol " +
            "(see the harness-control-plane entry) or the run refuses"}`;
        }).join("; ") + ". " +
        "The prefixes: /auth/v1 -> auth; /rest/v1/rpc/ -> rpc; /rest/v1 -> postgrest; /graphql/v1 -> " +
        "graphql; /storage/v1 -> storage; /realtime/v1 -> realtime; /functions/v1 -> functions; /pg " +
        "and /pg/* -> pg; /__canary* -> harness; \"/\" -> kong (the Kong root); an ABSENT, null or empty " +
        "path -> unclassified, because a record that does not say where it went has not earned the name of " +
        "the root path; ANYTHING ELSE -> unclassified. AN UNCLASSIFIED DESTINATION IS A REFUSAL, NOT A SILENCE: it is read by " +
        "noUnexpectedNetworkCall, because a destination this harness cannot name is unattributed, and " +
        "unattributed is not absent. The per-surface counts are published for every generation in " +
        "claimEvidence.gatewayRowsByClass and printed with the verdict, including the zeroes, so " +
        "'this run found no /storage/v1 row' is distinguishable from 'this run has no notion of " +
        "/storage/v1'. Measured on the frozen certifying corpus: 555 rows per generation, all harness, " +
        "every other class 0, rc=0 PASS unchanged. " +
        "WHAT THIS DOES NOT CLAIM. (1) The list of surfaces is the Supabase surface as this harness " +
        "knows it; a Supabase deployment that grows a new front door gets 'unclassified', which " +
        "refuses — the correct direction, but the harness will not know its name. (2) The gateway 404s " +
        "every surface except /auth/v1, /rest/v1 and /__canary, so a row on one of the others is a " +
        "record of an ATTEMPT, not of a completed storage read; what is being certified is that the " +
        "frozen artifact made no such attempt. (3) The three-way mapping graphql/pg -> noDatabaseCall " +
        "and storage/realtime/functions/kong -> noUnexpectedNetworkCall is a judgement about which " +
        "claim's NAME is true of each surface, not a measurement. (4) The image-side half is scoped to " +
        "egress the record itself addresses to the gateway (detail.hostClass supabase-sink, or any host " +
        "field naming " + JSON.stringify(HARNESS_SINK_HOST) + "), so a loopback path that merely looks " +
        "like a Supabase route is not counted; a non-gateway host is already stray by host class.",
    },
    {
      id: "harness-control-plane",
      inherent: false,
      statement:
        "THE ONE CLASS NO CLAIM READS IS A LIVE, UNAUTHENTICATED CONTROL PLANE THE IMAGE CAN ALSO REACH " +
        "(R9-1). GATEWAY_CLASS_READERS maps ten of its eleven classes to a claim; the eleventh, " +
        "'harness', is mapped to none, and until round 9 a row of that class was counted and skipped by " +
        "the attribution as well. The exemption was derived from the PATH, which is what stops a " +
        "/rest/v1 row buying it with a word — but a path prefix is not a caller, and the document " +
        "described the class as 'the driver's own /__canary control traffic', which is a statement about " +
        "WHO that nothing checked. " +
        "MEASURED. The recording gateway serves /__canary/{cell,health,generation,observe} to anything " +
        "that can open a socket to it, with no credential of any kind, and run.sh puts the image under " +
        "test on that network with SUPABASE_SERVER_URL=http://nt-canary-sink:8000. A throwaway container " +
        "on an --internal network with the real sink.mjs and a real Postgres got: POST /__canary/cell -> " +
        "200, and the gateway's attribution tag became the value THE CALLER chose; GET /__canary/health " +
        "-> 200, the gateway running a query on the caller's behalf; GET /__canary/generation -> 200, the " +
        "gateway running the catalogue query and handing back the schema fingerprint; POST " +
        "/__canary/observe -> 200 {\"recorded\":true}, the caller writing a record into the log this " +
        "harness treats as the second observer. The control in the same session, GET /rest/v1/accounts, " +
        "was 401: the DATA plane needs a token, the CONTROL plane does not. Splicing one of those REAL " +
        "gateway rows into a genuine 48-cell certifying corpus inside a claimed request window gave rc=0, " +
        "the PASS banner, hardFailures 0, noUnexpectedNetworkCall 480 satisfied / 0 violated and " +
        "noDatabaseCall 480 satisfied / 0 violated — while the same client's REFUSED /rest/v1/accounts " +
        "row, spliced the same way, was rc=1 FINDING. " +
        "WHAT IS CLOSED. Every /__canary row must now be traffic the driver's protocol produces: the " +
        "right path by the right method under the right tag class, under a tag this run's own cell " +
        "results account for, and once. The protocol is " +
        Object.entries(HARNESS_PROTOCOL)
          .map(([tc, m]) => `${tc}{${Object.entries(m).map(([pp, mm]) => `${mm} ${pp}`).join(", ") || "nothing"}}`)
          .join(" ") + ". Measured over both fixtures: 555 of 555 rows per generation accounted on the " +
        "48-cell corpus, 26 of 26 on the 1-cell one, rc=0 PASS unchanged; and eleven planted shapes — " +
        "health or generation under a request tag, a second observe or cell under a tag that already has " +
        "one, health under an #idle tag, a /__canary/cell announcing a tag no cell result accounts for, " +
        "an unenumerated /__canary path, GET /__canary/started, a second generation under (unset), and " +
        "observe under a #witness tag — are each rc=3, naming the row and the reason. " +
        "WHAT IS NOT CLOSED, PRECISELY. Before the driver announces the first cell tag of a generation " +
        "the gateway's tag is '(unset)', and run.sh's own readiness probe is GET /__canary/health in that " +
        "window, retried until the gateway reaches the database. An image that calls GET /__canary/health " +
        "while the FIRST cell of a generation is booting lands in that bucket and is indistinguishable " +
        "from the probe; measured, such a row still certifies. /__canary/started and /__canary/generation " +
        "are capped at one row each there, so the schema-fingerprint read and the boot row are refused; " +
        "what remains is the 'select 1' of a health check, in two windows per run. CLOSING IT NEEDS A " +
        "CREDENTIAL: the gateway must require a per-run control token the image does not hold (run.sh " +
        "already draws a 128-bit run nonce) and record its presence per row. That changes the recorded " +
        "shape of every gateway row and therefore needs a fresh matrix, which is why it is stated here " +
        "as a defect that was not closed rather than done badly against the existing corpus. " +
        "AND A SECOND-ORDER NOTE: because the tag the gateway stamps on its rows and on nt_canary.cell " +
        "comes from POST /__canary/cell, an image that calls it can mislabel subsequent rows. That " +
        "direction was checked and does not hide anything — a data-plane row under an invented tag is " +
        "unaccounted and refuses, a canary hit relabelled 'chal:' breaks the counter/server-log " +
        "agreement — but it can make a genuine run refuse, so a refusal of this kind is not by itself " +
        "evidence that the artefacts were edited.",
    },
    {
      id: "self-classified-host",
      inherent: false,
      statement:
        "ONE EGRESS CLASSIFICATION IS STILL COMPUTED BY THE PROCESS UNDER TEST: THE HOST. " +
        "This entry used to say EVERY egress claim read a self-computed classification and then name " +
        "only detail.hostClass. It named neither detail.pathClass nor the gateway row's own `kind`, and " +
        "it did not say that the harness's entire notion of 'the data plane' was TWO PATH PREFIXES. Both " +
        "of those are closed as of round 8 — the surface is derived from the path on the host side, for " +
        "the gateway's rows and for the image's own egress records alike (see data-plane-surface below), " +
        "and a record whose declared pathClass contradicts its own URL is refused " +
        "(claimEvidence.imageEgressPathClassContradictions). What remains self-classified is the HOST. " +
        "noBrokerCall and noUnexpectedNetworkCall are decided from detail.hostClass, which " +
        "instrument.cjs:116-123 derives inside the image's own process from NT_CANARY_BROKER_HOSTS and " +
        "NT_CANARY_SINK_HOST; nothing on the host side re-derives it from the detail.host sitting beside " +
        "it in the same record. A record reading hostClass=loopback with host=paper-api.alpaca.markets " +
        "is self-contradicting and would be believed. " +
        "THIS IS NOT CLOSED, AND IT IS NOT INHERENT. Round 5 measured the artefact-editor half of it and " +
        "closed that half: the gateway's attestation now covers a canonical digest of each event's " +
        "detail, so someone editing the directory afterwards cannot relabel a broker call without " +
        "contradicting a file they did not write, and the same edit under the pre-round-5 attestation " +
        "certified. What is left is the IMAGE lying in its own log while the driver and the gateway " +
        "faithfully record the lie, and that half is not closed. It would cost pinning the harness's two " +
        "host constants in expected/request-manifest.json, re-deriving the class from detail.host on the " +
        "host side, and refusing a record that disagrees with itself — a real check, but a WEAK one, " +
        "because an image willing to write the wrong class is equally able to write the wrong host, or " +
        "to emit no event at all. It is recorded here as a defect that was not closed rather than as a " +
        "property of the mechanism, because it is the former. " +
        "What does not depend on any of this: the canary sensor is a database trigger, the gateway's log " +
        "is written by the gateway, and the container network is --internal, so a broker call cannot " +
        "leave the host whatever the instrument says about it.",
    },
    {
      id: "run-controls",
      inherent: false,
      statement:
        "FIVE THINGS THE RUN COLLECTS ARE NOW READ HERE THAT WERE NOT READ AT ALL. Audit finding F — an " +
        "absence is only evidence from a detector known to work — was closed for exactly one detector, " +
        "the trusted runner's sensor report. Four controls were asserted inside run.sh's own process and " +
        "read by nothing afterwards, and a fifth artefact was collected and never opened. MEASURED " +
        "against the code as shipped before this round, over a genuine 48-cell certifying set: deleting " +
        "instr/egress-control.jsonl and instr/egress-broker.txt gave rc=0 PASS; deleting those plus " +
        "canary-arm-<gen>.txt, sql/arm-<gen>.{out,err}, sql/on-error-stop-<gen>.err and " +
        "tombstone-<gen>.txt gave rc=0 PASS with no mention of any of them in the transcript or in this " +
        "file; and two lines appended to instr/0023-m-off__s-off__b-probe.applog — a 200 OK from " +
        "paper-api.alpaca.markets and a successful vault_create_secret rpc — gave rc=0 PASS. Each is now " +
        "re-derived from its artefact and published in controlEvidence above, with the numbers behind it, " +
        "and tests/k15-run-controls.test.sh holds it in place: 16 rejection cases, each asserting its OWN " +
        "failure class rather than 'some non-zero exit', plus a GREEN positive control and a MEASURED " +
        "case that reads the counters as numbers. Red-before, measured against this same code with the " +
        "derivation removed: 1 passed / 18 failed, every one of the eighteen reporting rc=0 with the " +
        "PASS banner present. " +
        "WHAT EACH ONE IS WORTH. §3c (egress classifier) is the control that makes noBrokerCall mean " +
        "anything: the artefact must carry an instrument.loaded whose configured broker hosts and sink " +
        "host equal the ones pinned in verdict.mjs, at least one event that both names a pinned broker " +
        "host and is classified 'broker', at least one that both names the gateway and is classified " +
        "'supabase-sink', none that names the gateway and is classified 'broker', and egress-broker.txt " +
        "must be re-derivable from egress-control.jsonl line for line. §8b/§8b2 (arming and fidelity) " +
        "recomputes the before/after comparison from sql/baseline-<gen>.out and sql/arm-<gen>.out rather " +
        "than believing that run.sh printed ok, and additionally requires the observed baseline to equal " +
        "sql/expected-baseline.<gen>.txt, so the two artefacts cannot agree with each other while both " +
        "are wrong. §7c (tombstone classification) must classify all three instrumented wrappers, record " +
        "result=PASS, and agree with expected/tombstone-state.<gen>.txt. " +
        "WHAT IS NOT CLOSED. §5b (ON_ERROR_STOP) can only be re-derived as far as its artefact goes: " +
        "sql/on-error-stop-<gen>.err is psql's stderr and it settles that the applier failed with the " +
        "exact expected class ('division by zero'), NOT that it stopped. The applier's EXIT STATUS is not " +
        "written into the artefact, so 'ON_ERROR_STOP was in effect' remains a run.sh-process-only " +
        "assertion. Recording the status, or a stdout witness proving the third statement never ran, " +
        "would close it and has not been done. More generally: these controls still RUN in run.sh's " +
        "process, because that is where the containers are. What changed is that their evidence must " +
        "exist, be internally consistent, and say what the control claims — which defeats deletion and " +
        "partial edits, and does not defeat an operator who rewrites the artefact and everything it is " +
        "cross-checked against together (see artefact-forgery). " +
        "THE APPLOG SCAN (instr/<gen>-<cell>.applog) is the weakest of the five and is included because " +
        "the alternative was to keep collecting the file and never open it. Every driven cell must have " +
        "one, an applog belonging to no cell result in this verdict is refused, and no line may name a " +
        "pinned broker host or one of the three instrumented wrapper routines. It is a keyword scan over " +
        "free text the image chose to print: it is a tripwire, not a claim, and an image that makes a " +
        "broker call silently prints nothing. No containment claim rests on it. filesScanned, " +
        "linesScanned and bytesScanned are published as numbers because zero hits is also what a scan " +
        "that never ran produces; measured on the certifying set, 48 files / 192 lines / 5424 bytes / 0 " +
        "hits, every applog being the same 113-byte framework boot banner. A future image whose banner " +
        "legitimately named a broker host would refuse here and have to be looked at. " +
        "A SIXTH PAIR WAS LEFT OUT OF THE ROUND-7 SWEEP AND IS CLOSED HERE (R8-3). §11 (canary " +
        "extraction). run.sh runs `grep -E 'NT_CANARY_' sql/canary-dump-<gen>.out > canary-<gen>.txt` " +
        "and loadCanary reads ONLY canary-<gen>.txt, so the sensor's own dump — collected, kept and " +
        "shipped in the artefact directory — was compared with nothing. MEASURED against the code as " +
        "shipped before this round: an NT_CANARY_ROW naming vault_create_secret from cell " +
        "m-off__s-off__b-probe#3 gives rc=1 FINDING with noVaultCall=violated when it is in " +
        "canary-0023.txt, and rc=0 PASS with noVaultCall 480 satisfied / 0 violated when the identical " +
        "line is present ONLY in sql/canary-dump-0023.out — while the directory still contains it. This " +
        "is the same comparison §3c already performs for egress-broker.txt against " +
        "egress-control.jsonl; the canary pair was simply not in R7-4. The extraction is now re-run " +
        "here over the dump and required to agree with the file the verdict reads, in both directions " +
        "and in order, with the marker-line count published so an agreement between two empty sets " +
        "cannot pass for agreement (controlEvidence.perSchema.<gen>.canaryExtraction). Both directions " +
        "REFUSE rather than report a finding, because when two artefacts disagree neither of them can " +
        "be believed from here; the honest case — the row in the dump AND in the extraction — is still " +
        "rc=1 FINDING with noVaultCall violated. Measured on the frozen certifying corpus: 5 NT_CANARY_ " +
        "line(s) of 5 in each dump, 5 in each extraction, agrees, rc=0 PASS unchanged.",
    },
    {
      id: "generation-witness",
      inherent: true,
      statement:
        "The generation each cell was driven against is established by an md5 the RECORDING GATEWAY " +
        "computes over the running database's public catalogue — every relation column, every routine " +
        "identity signature, every constraint — compared with the fingerprint this checkout pins for " +
        "that generation and with the copy in the gateway's own log. That is a statement about the " +
        "SHAPE of the database, not about its history: it proves the cell met a database whose " +
        "catalogue is the one 0001-0008 (or 0001-0023) produces, not that those migration files were " +
        "the thing that produced it. Any database with a byte-identical catalogue satisfies it. This " +
        "is inherent to fingerprinting a live server rather than trusting a label, and it is the " +
        "stronger of the two: the alternative is believing the filename. What closes the remaining gap " +
        "is outside the witness — run.sh applies the migrations itself, from the directory named in " +
        "provenance.json, onto a postgres image pinned by digest. It also cannot distinguish two " +
        "generations that happen to have identical catalogues; the run refuses a manifest that pins " +
        "both generations to one fingerprint, which detects that case rather than repairing it.",
    },
    {
      id: "harness-provenance",
      inherent: false,
      statement:
        "The harness directory is not committed to git. The run records TRUSTED_DIGEST over its own " +
        "files and refuses to run when that digest does not match expected/trusted-digest.txt, but the " +
        "pin lives in the same working tree as the files it pins. Until the harness is committed, that " +
        "is a consistency check, not an independent one.",
    },
    {
      id: "verifier-digest-scope",
      inherent: false,
      statement:
        "TRUSTED_DIGEST covers every file under runtime-canary/ that the harness reads to decide an " +
        "outcome: *.sh, *.mjs, *.cjs, *.sql, *.json, *.sha256* and *.txt, hashed by content with the " +
        "relative path, excluding expected/trusted-digest.txt itself (it cannot pin itself). It does " +
        "NOT cover *.md, deliberately: documentation does not change what the harness accepts, and " +
        "pinning it would train the reflex of re-recording the pin for a typo. The .txt expectations " +
        "were outside this digest until an audit found the comment claiming 'every expectation' while " +
        "six expectation files — the tombstone-state, sensor-object and baseline files — were not " +
        "hashed at all; tests/k12-verifier-digest.test.sh now asserts each of them is inside it. It is " +
        "also asserted EXHAUSTIVELY: every file in the tree is probed one at a time and the set outside " +
        "the digest must be exactly those two documented exclusions, because a hand-written list of " +
        "twelve cannot notice a thirteenth file nobody thought of.",
    },
    {
      id: "transcript-vs-this-file",
      inherent: false,
      statement:
        "THIS FILE, not the printed transcript, is the machine-readable record. The transcript used to " +
        "be lossy: node writes to a pipe asynchronously and process.exit() discards what is queued, so " +
        "captures of one refusal through $( … 2>&1 ) measured anywhere between 92082 and 330509 bytes, " +
        "the short ones missing most of the matrix and this whole scope block. console.log and " +
        "console.error now write with fs.writeSync and tests/k13-transcript-integrity.test.sh executes " +
        "the old behaviour as a deterministic red-before. Any reader that greps the transcript — " +
        "especially for the ABSENCE of a string — should read verdict-scope.json instead: an absence " +
        "assertion over a lossy transcript is satisfied by the loss. That instruction was itself unsafe " +
        "until now: the refusals that exit BEFORE the verdict stage — PROVENANCE_CONTRADICTED and " +
        "twenty-two others — wrote nothing, so over a directory that had already been verdicted the " +
        "PREVIOUS run's {\"status\":\"PASS\"} survived the refusal (measured 6m46s stale). This file is " +
        "now DELETED before anything else happens and rewritten by a process-exit hook that cannot be " +
        "forgotten, so a green here is never a leftover, and a run that dies before printing a reason " +
        "leaves status NO_VERDICT rather than nothing. Two states are meaningful: a document whose " +
        "verdictReached is false is a refusal; NO FILE AT ALL means verdict.mjs rejected its own command " +
        "line before it had an output directory to write to.",
    },
    {
      id: "one-image-one-commit",
      inherent: true,
      statement:
        "A PASS is a statement about one image, built from one source tree, bound to one commit, on the " +
        "two migration generations named in the manifest. It says nothing about any other image, any " +
        "later commit, or any generation not driven. " +
        "THE BINDING IS NOW RE-DERIVED HERE, AND UNTIL ROUND 9 IT WAS NOT (R9-2). run.sh computes the " +
        "three digests (--source, the image's org.nt.canary.source-digest label, the tree at " +
        "--target-sha) and requires them equal before it drives anything, then writes all of them into " +
        "provenance.json — and nothing read them again: a literal scan of driver/ for sourceDigest, " +
        "commitTreeDigest, imageSourceDigest, imageRevision and targetSha returned zero hits while " +
        "provenance.json returned twelve. MEASURED over a genuine 48-cell certifying corpus: rewriting " +
        "provenance.json so that sourceDigest != commitTreeDigest, or imageSourceDigest != sourceDigest, " +
        "or imageRevision != targetSha — each on its own, and all three at once — produced rc=0, the PASS " +
        "banner and hardFailures 0, with this very sentence printed underneath it. Since round 9 the " +
        "binding is re-derived from provenance.json, published as " +
        "controlEvidence.imageSourceBinding, and a record that contradicts itself or omits a field is a " +
        "hard failure. WHAT THAT IS WORTH: provenance.json is written by the driver, so this is " +
        "tamper-evidence of the same kind as the pathClass and gateway-kind cross-checks — it refuses a " +
        "record that disagrees with itself. It is NOT an independent attestation of the binding, and an " +
        "operator who edits all five fields consistently is inside the artefact-forgery limit above.",
    },
  ];
}

/* `scopeWritten` is declared at the top of the file, beside the exit hook that
 * reads it (ADV-4). */
function writeScope(status) {
  if (scopeWritten) return;
  scopeWritten = true;
  const scope = {
    status,
    mode: O.mode,
    breakSensor: O.breakSensor,
    certifying: CERTIFYING,
    schemasDriven: O.schemas,
    manifest: path.basename(O.manifest),
    runNonce: PROV ? PROV.runNonce : null,
    /* THE SENSOR VERDICT, RECORDED (audit finding F).
     * This file said nothing at all about whether the detector had been shown
     * to work, so deleting every trusted-runner artefact and asserting
     * TRUSTWORTHY on the command line produced a PASS that no downstream
     * reader could question. Both the derived value and the asserted one are
     * written out, so they can be compared by something other than this
     * process. */
    sensorVerdict: Object.fromEntries(
      [...sensorEvidence.entries()].map(([s, e]) => [s, e])),
    /* WHICH DATABASE IMAGE (audit finding E). */
    pgImage: PROV ? PROV.pgImage || null : null,
    pgImagePinned: PG_IMAGE_PINNED,
    pgImagePinnedExpected: CERTIFYING ? MANIFEST.pinnedPgImage : null,
    /* WHETHER THE RUN'S OWN CONTROLS RAN, AND WHAT THEIR ARTEFACTS SAY
     * (R7-4), AND THE SCAN OF THE IMAGE'S OWN STDOUT (R7-3). Four controls
     * used to be asserted inside run.sh's process and read by nothing after
     * it exited; deleting all of their artefacts produced a full certifying
     * PASS that mentioned none of them. Every one of them is now re-derived
     * from its artefact above and published here, satisfied or not. */
    controlEvidence,
    /* HOW THE IN-PROCESS CLAIMS WERE DECIDED (audit finding D). */
    claimEvidence: Object.fromEntries(
      [...observerEvidence.entries()].map(([s, e]) => [s, e])),
    generationWitnessObserved: Object.fromEntries(
      [...observedWitnesses.entries()].map(([s, set]) => [s, [...set]])),
    generationWitnessPinned: CERTIFYING
      ? Object.fromEntries(MANIFEST_SCHEMAS.map((s) => [s, MANIFEST.schemaWitness[s].fingerprint]))
      : null,
    hardFailures: hardFailures.length,
    claimStatus: Object.fromEntries([...claimTally.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    doesNotClaim: scopeStatements(),
  };
  try { fs.writeFileSync(path.join(O.out, "verdict-scope.json"), JSON.stringify(scope, null, 2)); }
  catch (e) { console.error(`  (could not write verdict-scope.json: ${e.message})`); }
  console.log(`\n${BOLD}WHAT THIS VERDICT DOES NOT SAY${OFF}  (also in verdict-scope.json)`);
  for (const s of scope.doesNotClaim) {
    console.log(`  - [${s.id}${s.inherent ? ", inherent" : ""}] ${s.statement.replace(/\s+/g, " ")}`);
  }
}

/* -- the sensor-integrity gate --------------------------------------------- */
console.log("");
if (!consultedSensor) {
  console.error(`${RED}SENSOR_IGNORED${OFF} the verdict was produced without reading the canary.`);
  console.error("  A pass that never consulted the sensor is not a pass. This is the");
  console.error("  property-(C) control for a checker that quietly stops looking.");
  writeScope("SENSOR_IGNORED");
  process.exit(EXIT_CONTROL);
}

/* -- hard failures beat every other outcome -------------------------------- */
if (hardFailures.length) {
  console.error(`${RED}INCOMPLETE OBSERVATION${OFF} ${hardFailures.length} hard failures; this run cannot render a verdict:`);
  for (const m of hardFailures.slice(0, 40)) console.error(`  - ${m}`);
  if (hardFailures.length > 40) console.error(`  … and ${hardFailures.length - 40} more`);
  console.error("\n  A claim that could not be observed is not a claim that held.");
  writeScope("INCOMPLETE_OBSERVATION");
  process.exit(EXIT_CONTROL);
}

/* -- the expectation for this mode ----------------------------------------- */
const totalViolating = summary.reduce((a, s) => a + s.totalViolating, 0);
const totalHits = summary.reduce((a, s) => a + (s.totalHitDelta || 0), 0);
const anyCommitMoved = summary.some((s) => s.commitMoved);

if (O.mode === "frozen") {
  console.log(`${BOLD}PROPERTY A — the frozen image must produce ZERO canary hits${OFF}`);
  console.log(`  canary hits caused by the whole matrix : ${totalHits}`);
  console.log(`  requests violating a claim             : ${totalViolating}`);
  console.log(`  commitments moved                      : ${anyCommitMoved}`);
  if (totalHits !== 0) {
    console.error(`\n${RED}FINDING${OFF} the frozen image REACHED a tombstoned wrapper.`);
    exitCode = Math.max(exitCode, EXIT_FINDING);
  }
  if (totalViolating !== 0 || anyCommitMoved) {
    console.error(`\n${RED}FINDING${OFF} the frozen image violated at least one containment claim (see the matrix above).`);
    exitCode = Math.max(exitCode, EXIT_FINDING);
  }
} else {
  console.log(`${BOLD}PROPERTY B — the unfrozen mutant MUST reach the canary${OFF}`);
  console.log(`  canary hits caused by the whole matrix : ${totalHits}`);
  console.log(`  requests violating a frozen-image claim: ${totalViolating} (expected: many)`);
  if (totalHits === 0) {
    console.error(`\n${RED}CONTROL FAILED${OFF} the deliberately-unfrozen image produced no canary hits.`);
    exitCode = Math.max(exitCode, EXIT_CONTROL);
  } else {
    console.log(`\n${GREEN}SENSOR PROVEN LIVE${OFF} the same stack records a real call when one is made.`);
  }
}

/* -- a partial run is a distinct status, never a pass ---------------------- */
const fullSchemaCount = MANIFEST_SCHEMAS ? MANIFEST_SCHEMAS.length : O.schemas.length;
const fullCombinations = MANIFEST.cells * fullSchemaCount;
const drovenCombinations = (O.cellsRun !== null ? O.cellsRun : MANIFEST.cells) * O.schemas.length;

if (PARTIAL) {
  const drove = summary.reduce((a, s) => a + s.totalRequests, 0);
  console.log("");
  console.log(`${YELLOW}PARTIAL${OFF} ${drovenCombinations} of ${fullCombinations} environment/schema combinations were driven ` +
              `(${drove} of ${MANIFEST.totalRequests * fullSchemaCount} manifest requests).`);
  if (CELLS_PARTIAL) {
    console.log(`  cell axis  : ${O.cellsRun} of ${O.cellsTotal} freeze-flag combinations`);
  }
  if (SCHEMA_PARTIAL) {
    console.log(`  schema axis: ${O.schemas.join(",")} of ${MANIFEST_SCHEMAS.join(",")} ` +
                `(never driven: ${SCHEMAS_MISSING.join(",")})`);
  }
  console.log("  Everything that WAS driven behaved as the mode expects, and that is all this");
  console.log("  run can support. A subset of the matrix cannot establish a property of the");
  console.log("  matrix, so this is not a PASS and the exit status says so.");
  writeScope("PARTIAL");
  process.exit(Math.max(exitCode, EXIT_PARTIAL));
}

/* -- a real, complete run that still cannot certify a commit --------------- */
if (NON_CERTIFYING_REASONS.length) {
  console.log("");
  console.log(`${YELLOW}NOT CERTIFYING${OFF} the whole matrix was driven and behaved as the mode expects, but:`);
  for (const r of NON_CERTIFYING_REASONS) console.log(`  - ${r}`);
  console.log("  The PASS banner is a statement about a commit's artifact. This run cannot make one.");
  writeScope("NOT_CERTIFYING");
  process.exit(Math.max(exitCode, EXIT_PARTIAL));
}

if (exitCode === 0 && O.mode === "frozen") {
  console.log(`\n${GREEN}PASS${OFF} all ${MANIFEST.cells} environment combinations x ${fullSchemaCount} migration generations ` +
              `(${fullCombinations} combinations) x ${MANIFEST.requestsPerCell} requests x ${REQUIRED_CLAIMS.length} claims ` +
              `were observed complete, refused with ${O.expectStatus}, and the canary never fired.`);
  console.log(`      every one of the ${MANIFEST.cells} committed cell identities was driven on each generation, each was ` +
              `observed running its own freeze-flag triple, and each generation was confirmed to be the`);
  console.log(`      migration generation it is filed under by a fingerprint the recording gateway read out of that ` +
              `running database and logged separately.`);
}
writeScope(exitCode === 0 ? (O.mode === "frozen" ? "PASS" : "SENSOR_PROVEN_LIVE") : "FINDING");
process.exit(exitCode);
