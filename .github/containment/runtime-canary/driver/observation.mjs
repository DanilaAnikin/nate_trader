/* ==========================================================================
 * observation.mjs — ONE canonical description of one driven request
 *
 * WHY THIS FILE EXISTS (audit findings B and C)
 * ---------------------------------------------
 * Two forgeries obtained a full certifying PASS by rewriting NOTHING but the
 * cell-result files, using values the other two containers' logs handed them:
 *
 *   B  0008's twenty-four cell results filed under 0023's filenames, with
 *      `schema`, `dbWitness` and `bootEvents` pasted out of the real 0023
 *      results that were already sitting in the same directory.
 *   C  one 0023 cell's `results` array pasted into the other twenty-three,
 *      with `cell`, every `cellTag`, `instrumentEnv.raw_freeze_flags` and
 *      `bootEvents` repaired from the manifest and from the instrument logs
 *      the check compares against. Measured afterwards: 1 distinct
 *      request-observation record across the 24 certified cells, against 24
 *      in the genuine set.
 *
 * Every identity check the verdict had was a statement about WHICH CELL and
 * WHICH GENERATION. Nothing was a statement about the REQUEST OBSERVATIONS
 * themselves — the statuses, headers, bodies, timings, event and marker
 * readings that the claims are actually decided from. Those could be copied
 * freely between cells and between generations, because the frozen image
 * refuses every request identically and the copies are therefore
 * indistinguishable from the truth by inspection.
 *
 * The closure is to stop the cell result being the only copy. The driver now
 * hands the RECORDING GATEWAY — a different container, writing a different
 * host bind mount — a canonical description of each request the moment it
 * finishes, and the gateway logs it. `verdict.mjs` recomputes that description
 * from the cell result and requires it to equal the gateway's copy, field by
 * field. A cell result rewritten after the run contradicts a log the rewriter
 * did not write.
 *
 * The derivation lives HERE, in one file imported by both `drive.mjs` (inside
 * the driving container, from /canary) and `verdict.mjs` (on the host), so the
 * two sides cannot drift into computing different things and calling the
 * difference a forgery.
 *
 * WHAT IT IS NOT. This is not a signature. The driver originates the values it
 * attests, so a driver that lies at run time is not caught by it — only an
 * artefact directory edited afterwards is. See the `artefact-forgery` scope
 * statement, which now says exactly that.
 * ========================================================================== */

import crypto from "node:crypto";

/** Bumped when the field set below changes, so an old attestation cannot be
 *  silently compared against a new derivation.
 *
 *  2 — ROUND-5 AUDIT. `eventDigest_16` covered `[seq, t, kind]` and nothing
 *      else. The `detail` object — the host, the port, the path class, the
 *      env-var name, i.e. EVERY FIELD ANY CLAIM ACTUALLY READS — was attested
 *      by nothing and compared by nothing. See `eventIdentity` below.
 *
 *      There is deliberately NO compatibility shim for version 1. An artefact
 *      directory produced before the bump genuinely does not carry the
 *      evidence, and accepting it "because it is old" would make the check's
 *      passing value identical to its did-not-run value. Such a directory now
 *      refuses, naming the version; re-run to certify it. */
export const OBSERVATION_VERSION = 2;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** JSON with every object's keys in sorted order, so two serialisations of the
 *  same value are the same string. The instrument writes its log line and the
 *  driver re-serialises its transcription; nothing guarantees they emit the
 *  same key order, and a false difference is as bad as a missed one. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

/**
 * THE IDENTITY OF ONE INSTRUMENT EVENT — including what it says happened.
 *
 * ROUND-5 AUDIT, red measured on this exact code. Both cross-checks over the
 * in-process events keyed them on `(seq, t, kind)`:
 *
 *   - `observers.mjs` `eventKey`, which decides whether the image's own log and
 *     the driver's transcription "agree";
 *   - `eventDigest_16` here, which is what the RECORDING GATEWAY attests.
 *
 * A `fetch` whose detail said `host: paper-api.alpaca.markets, hostClass:
 * broker` was rewritten, in both instrument-side copies, to `host: 127.0.0.1,
 * hostClass: loopback`. Nothing else changed — same seq, same t, same kind, so
 * the same eventDigest_16 and the same gateway attestation. The verdict went
 * from `noBrokerCall=violated` / rc=1 (the honest run, all three writers
 * consistent) to a full certifying PASS. Two files edited; the third observer,
 * whose whole purpose is to make a two-file edit inconsistent, could not see
 * the field the claim is decided from because it never hashed it.
 *
 * The identity now covers the detail. The digest is truncated the same way the
 * rest of this file truncates — this is a tamper-evidence key, not a signature,
 * and the file says so.
 *
 * WHAT IS STILL OUT, DELIBERATELY: `stack`. No claim reads it, and the driver
 * is not guaranteed to transcribe it byte-for-byte, so including it would buy
 * nothing and risk a false disagreement. If a future claim ever reads the
 * stack, it belongs in here on the same day — that is the rule this function
 * exists to enforce: the identity covers what the decisions read.
 *
 * ROUND-7 AUDIT (R7-2). THE EXCLUSION WAS NOT "stack". IT WAS "EVERYTHING THAT
 * IS NOT ONE OF FOUR FIELDS".
 *
 * `stack` is excluded deliberately and the paragraph above says so — but
 * nothing refused an UNKNOWN top-level key, so the real exclusion was open
 * ended, and it survived the SUITE as well as the verdict. MEASURED on the
 * certifying corpus: appending
 *
 *     ,"brokerCall":{"method":"POST","url":"https://paper-api.alpaca.markets/v2/orders",…}
 *
 * to an EXISTING boot line of instr/0023-m-off__s-off__b-probe.jsonl left every
 * published count identical — 13 raw lines in that file, logEvents 298, boot
 * 298, unattributed 0 — and still certified with rc=0 and the PASS banner. It
 * is not caught by R7-1's line accounting either: the line still parses, so
 * `grep -c .` and the event count agree, and k14's MEASURED comparison is
 * green over an artefact directory recording a broker call.
 *
 * The closure is the SAME ARGUMENT `bootEventProblem` already makes for kinds:
 * an allow-list over an exhaustive partition, refusing what nobody enumerated
 * instead of admitting it. `instrument.cjs` `emitWithStack` writes exactly
 * `{seq, t, kind, detail, stack}` and nothing else, so the partition really is
 * exhaustive, and a record carrying a sixth key is either a future instrument
 * (in which case that key belongs in `eventIdentity` and in this list, in the
 * same change) or something nothing in this harness wrote.
 *
 * The alternative — digesting the WHOLE record — was rejected because it would
 * fold `stack` back in through the side door and reintroduce exactly the false
 * disagreements the exclusion above exists to avoid.
 */

/** Every top-level key `instrument.cjs` `emitWithStack` writes, and no other.
 *  `eventIdentity` covers seq/t/kind/detail; `stack` is excluded from the
 *  identity on purpose, and is on this list because the record may legitimately
 *  carry it. Anything else is refused rather than ignored. */
export const EVENT_TOP_LEVEL_KEYS = ["seq", "t", "kind", "detail", "stack"];
const EVENT_TOP_LEVEL_KEY_SET = new Set(EVENT_TOP_LEVEL_KEYS);

/**
 * The top-level keys of one instrument event that `eventIdentity` does not
 * cover and `instrument.cjs` does not write — sorted, empty when there are
 * none. A non-object is reported as `["(not an object)"]`: a JSON scalar or
 * array on a line of an instrument log is not an event either.
 */
export function eventForeignKeys(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["(not an object)"];
  return Object.keys(e).filter((k) => !EVENT_TOP_LEVEL_KEY_SET.has(k)).sort();
}

export function eventIdentity(e) {
  const detail = e && typeof e.detail === "object" && e.detail !== null ? e.detail : null;
  return [
    e && e.seq, e && e.t, e && e.kind,
    sha(canonicalJson(detail)).slice(0, 16),
  ];
}

/** The response headers the driver records, in a fixed order: an object's key
 *  order is not part of what is being attested. */
export const ATTESTED_HEADERS = [
  "content-type", "x-artifact-role", "x-writes-enabled",
  "retry-after", "cache-control", "location",
];

const num = (v) => (v === null || v === undefined ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v));

/**
 * The canonical description of one request observation.
 *
 * Derived from the SAME shape on both sides: `drive.mjs` builds the result
 * entry first and then calls this, and `verdict.mjs` calls it on the entry it
 * reads back out of the cell file. Anything that is part of the evidence a
 * claim is decided from belongs in here; anything the harness may legitimately
 * recompute does not.
 */
export function observationFields(runNonce, schema, cell, r) {
  const res = r && r.response ? r.response : null;
  const events = Array.isArray(r && r.events) ? r.events : null;
  const marks = r && r.markDelta && typeof r.markDelta === "object" ? r.markDelta : {};
  return {
    v: OBSERVATION_VERSION,
    runNonce: String(runNonce || ""),
    schema: String(schema || ""),
    cell: String(cell || ""),
    id: str(r && r.id),
    tag: str(r && r.cellTag),
    // The two ends of the request, in the driving container's clock. The
    // gateway timestamps its own copy, so these can be — and are — required to
    // fall inside the window the gateway recorded for this tag.
    t0: num(r && r.t0),
    t1: num(r && r.t1),
    method: str(r && r.method),
    template: str(r && r.template),
    url: str(r && r.url),
    authenticated: r && r.authenticated ? 1 : 0,
    sentBody: r && r.sentBody ? 1 : 0,
    status: res ? num(res.status) : null,
    error: r && r.error !== null && r.error !== undefined ? String(r.error) : null,
    bodyBytes: res ? num(res.bodyBytes) : null,
    bodySha256_16: res ? sha(res.body === null || res.body === undefined ? "" : res.body).slice(0, 16) : null,
    headers: res
      ? ATTESTED_HEADERS.map((h) => [h, res.headers && res.headers[h] !== undefined ? str(res.headers[h]) : null])
      : null,
    // The in-process instrument's reading for this request's window, as the
    // driver transcribed it. `verdict.mjs` also compares the transcription
    // against the instrument's OWN log; this pins the transcription itself so
    // that neither copy can be quietly rewritten later.
    eventCount: events ? events.length : -1,
    // v2: `eventIdentity`, not `[seq, t, kind]`. See the note on that function.
    eventDigest_16: sha(JSON.stringify((events || []).map(eventIdentity))).slice(0, 16),
    markDigest_16: sha(JSON.stringify(
      Object.keys(marks).sort().map((k) => [k, marks[k]]))).slice(0, 16),
    marksReadable: r && r.marksReadable ? 1 : 0,
    routeIndexed: num((r && r.routeIndexed) || 0),
    routeExec: r && r.routeExec !== null && r.routeExec !== undefined ? Number(r.routeExec) : null,
  };
}

/** A digest over the canonical description. JSON.stringify preserves the
 *  literal's key order, and every value above is a primitive or an array, so
 *  this is deterministic on both sides. */
export function observationDigest(fields) {
  return sha(JSON.stringify(fields));
}

/** Field-by-field difference, for a message that names what disagrees rather
 *  than only that something does. */
export function diffObservations(want, got) {
  if (!got || typeof got !== "object") return ["the gateway logged no observation record"];
  const diffs = [];
  // Only the attested fields. The gateway's row also carries its own `seq`,
  // its own receive time, the digest and the cell it was serving; those are
  // checked separately and would otherwise drown the real difference.
  for (const k of Object.keys(want)) {
    const a = JSON.stringify(want[k]);
    const b = JSON.stringify(got[k]);
    if (a !== b) diffs.push(`${k}: result says ${a}, the gateway logged ${b}`);
  }
  return diffs;
}
