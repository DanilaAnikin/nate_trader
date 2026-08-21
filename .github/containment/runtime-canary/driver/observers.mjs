/* ==========================================================================
 * observers.mjs — the two files the driver did NOT write, read as evidence
 *
 * THE DEFECT THIS CLOSES (audit finding D)
 * ----------------------------------------
 * `verdict.mjs` collected three observers and believed one of them. Every
 * in-process claim — `noBodyParse`, `noSupabaseClient`, `noBrokerCall`,
 * `noDatabaseCall`, `noUnexpectedNetworkCall`, `noAuthCall`,
 * `noPostgRESTCall` — was decided from `results[].events`, the DRIVER'S
 * TRANSCRIPTION of what the in-process instrument reported over the control
 * surface. The instrument's own log, `$OUT/instr/<schema>-<cell>.jsonl`, was
 * read for exactly one thing: the presence of an `instrument.loaded` line and
 * the boot events. The gateway's log was read for cell tags and the generation
 * fingerprint. The rest of both files was collected, shipped and ignored.
 *
 * An adversarial audit appended two lines to
 * `instr/0023-m-off__s-off__b-probe.jsonl` — a `body.parse` and a `fetch` to
 * `paper-api.alpaca.markets`, inside a request window — and left every cell
 * result exactly as the driver had written it. The verdict printed
 *
 *     PASS all 24 environment combinations x 2 migration generations
 *     (48 combinations) …
 *
 * with `noBodyParse: 480 satisfied, 0 violated` and `noBrokerCall: 480
 * satisfied, 0 violated` in its own tally. No forgery was involved at all: the
 * image under test writes that file, and the harness exists to find out what
 * the image under test did.
 *
 * That is the harness inverted — the thing under test is its own reporter, and
 * the verdict believes it.
 *
 * WHAT THIS FILE PROVIDES
 * -----------------------
 * A request window is taken from the GATEWAY's log, never from the cell
 * result: the driver POSTs `/__canary/cell` with the next tag before every
 * request, and the gateway timestamps that POST in `sink-<schema>.jsonl`. So
 * the window for tag T runs from the gateway's first entry carrying T to its
 * first entry carrying the NEXT tag — a boundary that comes from the observer,
 * bounded by its own terminator, with nothing the driver wrote in it.
 *
 * The events inside that window come from the instrument's own log. Those are
 * the events the claims are then decided from.
 *
 * WHAT THE WINDOWS DO NOT COVER, AND WHY THAT WAS THE NEXT DEFECT (ADV-1)
 * ----------------------------------------------------------------------
 * A request window runs from the gateway's first entry carrying tag T to its
 * first entry carrying the next tag. The driver's per-cell tag sequence is
 * `#witness`, `#1` … `#10`, `#idle`, so the ten request windows cover only the
 * time the driver was issuing requests. MEASURED on the certifying set
 * `7da1ca7f…`: the ten request windows of a cell span about 2 s of a ~17.5 s
 * per-cell gateway timeline — 10.8% of generation 0008's cell time and 11.7%
 * of 0023's. The other ~89% is `#witness` and `#idle`: container teardown, the
 * next container's boot, and the gap either side of the request burst.
 *
 * Deciding the claims from the events INSIDE the windows therefore closed the
 * D attack and left the complement wide open. An auditor moved the same three
 * events — a dns.lookup, a socket.connect and a POST fetch to
 * paper-api.alpaca.markets, byte-faithful to the {seq,t,kind,detail,stack}
 * shape instrument.cjs emit() writes — to 742 ms after the cell's last window
 * closed, and got a full certifying PASS with "noBrokerCall: 480 satisfied, 0
 * violated". Nothing was forged: the instrument patches fetch/socket/tls/dns
 * process-wide at module load, so it records such a call by construction, and
 * run.sh:961 positively controls that it classifies that host.
 *
 * `attributeEvents` below is the closure. An event outside every request
 * window is not innocent — it is UNATTRIBUTED, and unattributed is not the
 * same as absent. Every line of the image's own log must be accounted for by
 * one of exactly two things: the boot snapshot the cell result declares, or
 * one bounded REQUEST window (`#witness` and `#idle` are the driver's own
 * bookends: they are boundaries, never windows, which is what REQUEST_TAG
 * enforces). Anything else is a hard failure.
 *
 * MEASURED, so neither the equality nor the attribution is a count-of-zero
 * nobody has seen fail for the right reason. Over the four distinct genuine
 * certifying runs still on this machine (run nonces 7da1ca7f…, 21e6a343…,
 * 55c8d4d3…, 3085a474…), each 48 cells x 2 generations = 480 request windows:
 *
 *   windows        1920 (4 x 480)
 *   log events     2385 (597 + 596 + 596 + 596)
 *   attributed     2385, every one of them to the boot snapshot the cell
 *                  result declares
 *   in a window       0  — a frozen image makes no call during a request
 *   unattributed      0
 *   window diffs      0
 *
 * ALL FOUR OF THOSE CORPORA ARE OBSERVATION_VERSION 1 OR OLDER (R7-5). Three
 * carry version 1; 3085a474 carries no request attestation at all. Version 1
 * is what tests/run-all.sh and tests/k14 now REFUSE as non-forward-portable,
 * so these figures cannot be re-derived by running the current harness over
 * the directories they came from — they are historical, and reproducing them
 * needs fresh version-2 matrices. Said here because a table of measured
 * numbers with no note reads as re-runnable.
 *
 * So on a genuine frozen set the IN-WINDOW bucket is empty, and an assertion
 * that it agrees with the driver's transcription there is vacuous. It is made
 * non-vacuous by the attack copies, which the suite runs every time: k14's D1
 * plants two events at a window midpoint and asserts they are SELECTED and
 * counted (eventsOnlyInObserverLog == 2, measured 596 -> 598 events with 2
 * in-window), and k14's ADV1 plants three after the last window closes and
 * asserts they are refused as UNATTRIBUTED.
 *
 * RE-VERIFIED BY THE ROUND-5 AUDITOR, by counting rather than by reading this
 * note: 480 windows and 597 log events for 7da1ca7f, 480/596 for each of the
 * other three, so 1920 and 2385; 0 of the 2385 inside any request window; the
 * kind census exactly instrument.coverage 192 / instrument.loaded 192 /
 * instrument.ready 192 / env.read 1809. The 10.8% and 11.7% coverage figures
 * reproduce to the decimal when the denominator is cell-to-cell gateway time
 * (first tag of this cell to first tag of the next): 2067 ms of 19101 ms per
 * cell on 0008, 2811 of 23951 on 0023. Measuring instead from #witness to
 * #idle gives 91%, which is the same numerator over a denominator that omits
 * the ~15 s teardown — the interval the attack lived in — so the denominator
 * is stated here explicitly rather than left to be guessed.
 *
 * AND THE SAME QUESTION ASKED OF THE GATEWAY'S LOG: 3960 entries across those
 * four runs, 3960 of them the harness's own /__canary control traffic, 0 of
 * any other kind. See `attributeGatewayRows` below — until round 5 nothing
 * looked at that log outside the request windows either, and a Supabase
 * data-plane call logged in the complement certified.
 *
 * SUPERSEDED, and why. An earlier note here published "720 windows carrying
 * 2179 real events, 0 diffs" over four sets — one frozen 48-cell set at 480
 * windows plus a mutant set, an out-A and an out-B at 240 windows each. 240 is
 * ONE generation: those three were single-generation runs, so the aggregate
 * mixed whole-matrix and half-matrix measurements without saying so. Worse for
 * a reader, those three directories no longer exist and no mutant image exists
 * at this sha, so the only part of that figure anyone can re-measure today is
 * the frozen one — where the in-window bucket is EMPTY. The numbers above are
 * the ones this checkout can reproduce; the real-mutant-timing measurement is
 * historical and is not re-derivable here.
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";
// The single copy of "what counts as the process reaching out". Held in
// claims.mjs because that is where the CLAIMS read it; imported here so the two
// readers of the same idea cannot drift apart again (round-5 audit — they had).
import { EGRESS_KINDS, REQUEST_ONLY_KINDS, classifyGatewayPath } from "./claims.mjs";
import { eventIdentity } from "./observation.mjs";

export const readLines = (p) =>
  (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean) : []);

/** A request tag is `<cellId>#<requestId>`; `#witness` and `#idle` are the
 *  driver's own bookends and are boundaries, never windows. */
export const REQUEST_TAG = /^(.+)#(\d+)$/;

/* ==========================================================================
 * ROUND-7 AUDIT (R7-1). THE CHEAPEST BREAK IN THIS PROGRAMME'S HISTORY: ONE
 * BYTE.
 *
 * This function used to be
 *
 *     for (const l of readLines(p)) {
 *       try { out.push(JSON.parse(l)); } catch { }   // "a truncated tail is
 *     }                                              //  not evidence"
 *
 * — a deliberate, uncounted, unreported drop, feeding BOTH `gatewayTimeline`
 * and `instrumentLog`, i.e. both observers. `verdict.mjs` repeated it twice
 * more, in `sinkByCell` and `sinkTruthByCell`. Nothing anywhere compared the
 * number of non-empty lines in the file with the number of events parsed out
 * of it, so the published denominators — `claimEvidence.logEvents` and
 * `claimEvidence.gatewayRows` — were computed from the same parsed set and
 * could not disagree with themselves.
 *
 * MEASURED on the certifying corpus (run nonce e2ac6c8b…, observation v2,
 * trusted digest a941f373…), all four with NOTHING else touched:
 *
 *   a byte-faithful broker fetch 742 ms into #idle       rc=3, 1 UNATTRIBUTED
 *   the SAME record with one trailing comma              rc=0, PASS banner,
 *                                                        noBrokerCall 480/0,
 *                                                        logEvents 298 over a
 *                                                        299-line file
 *   a GET /rest/v1/accounts under a cell's #idle tag     refused well formed,
 *                                                        PASS malformed,
 *                                                        gatewayRows 555 over
 *                                                        a 556-line file
 *   the final "}" of the planted line replaced by a
 *   SPACE — same byte count, same line count, cells/
 *   and sink-*.jsonl bit-identical                       rc=0, full PASS
 *
 * AND IT IS REACHABLE WITHOUT AN ADVERSARY, which makes it a reliability
 * defect as much as a security one: instrument.cjs writes each event with its
 * own `fs.appendFileSync`, and run.sh SIGKILLs the app container at the end of
 * every cell. A truncated or interleaved final line is a NORMAL-OPERATION
 * outcome of that design. Until now that outcome was discarded in silence, so
 * the harness's answer to "what did the image do?" quietly excluded whatever
 * it had been in the middle of writing.
 *
 * So an unparseable line is now RETURNED, with its physical 1-based line
 * number and its byte count, and `verdict.mjs` hard-fails on any of them,
 * naming the file and the line. The two denominators are published beside the
 * event counts (`claimEvidence.rawLines`, `claimEvidence.gatewayRawLines`,
 * `claimEvidence.linesUnparseable`) so a reader can check them against
 * `grep -c .` without running anything.
 *
 * `lineNo` is the PHYSICAL line number — blank lines included in the count,
 * excluded from the parse — because that is the number `sed -n '<N>p'` wants.
 * On a file with no blank lines it is also the `grep -c .` ordinal.
 * ========================================================================== */

/**
 * Every non-empty line of a JSONL file, parsed, WITH the ones that did not.
 *
 * @returns {{
 *   present: boolean,
 *   rows: object[],
 *   lineNos: number[],            // parallel to rows: the physical line each came from
 *   unparseable: Array<{lineNo:number, bytes:number, error:string, excerpt:string}>,
 *   rawLines: number,
 * }}
 */
export function parseJsonlFile(p) {
  const present = fs.existsSync(p);
  const rows = [];
  const lineNos = [];
  const unparseable = [];
  let rawLines = 0;
  if (present) {
    // Split on the raw text, not through readLines(): the physical index is
    // the whole point, and `.filter(Boolean)` throws it away.
    const physical = fs.readFileSync(p, "utf8").split("\n");
    for (let i = 0; i < physical.length; i++) {
      const l = physical[i];
      // "" is the split's trailing element after the final newline, and a
      // genuinely empty line. `grep -c .` counts neither, so neither does
      // rawLines — the two numbers have to be comparable by hand.
      if (l === "") continue;
      rawLines++;
      let v;
      try { v = JSON.parse(l); }
      catch (e) {
        unparseable.push({
          lineNo: i + 1,
          bytes: Buffer.byteLength(l, "utf8"),
          error: String(e && e.message ? e.message : e),
          excerpt: l.length > 160 ? `${l.slice(0, 157)}…` : l,
        });
        continue;
      }
      rows.push(v);
      // Parallel, never a property ON the parsed object: an event record is
      // compared field by field and judged by an allow-list over its own
      // top-level keys (R7-2), so decorating it here would corrupt the
      // evidence with the reader's bookkeeping.
      lineNos.push(i + 1);
    }
  }
  return { present, rows, lineNos, unparseable, rawLines };
}

/** One line of a refusal naming a file, a line and what the line says. */
export function describeUnparseable(rel, u) {
  return `${rel}:${u.lineNo} (${u.bytes} bytes, ${u.error}): ${u.excerpt}`;
}

/**
 * The gateway's timeline for one generation.
 *
 * `parsed` is the ALREADY-PARSED file when the caller has one (verdict.mjs
 * parses it once and hands the same record to `sinkByCell` and
 * `sinkTruthByCell`, which used to re-read and re-drop it separately). Passing
 * it is what stops three readers of one file disagreeing about its contents.
 *
 * @returns {{
 *   present: boolean,
 *   rows: object[],
 *   unparseable: Array<{lineNo:number,bytes:number,error:string,excerpt:string}>,
 *   rawLines: number,
 *   file: string,
 *   rel: string,
 *   windows: Map<string, {from:number,to:number,bounded:boolean}>,
 *   repeatedTags: string[],
 *   observations: Map<string, object[]>,
 * }}
 */
export function gatewayTimeline(out, schema, parsed) {
  const file = path.join(out, `sink-${schema}.jsonl`);
  const p = parsed || parseJsonlFile(file);
  const present = p.present;
  const rows = p.rows;

  // Consecutive runs of one tag. A tag that comes back after another tag has
  // intervened is reported rather than merged: it would mean the gateway saw
  // one cell tag twice, which the driver never does.
  const runs = [];
  for (const e of rows) {
    const tag = typeof e.cell === "string" ? e.cell : "";
    if (!tag || tag === "(unset)") continue;
    if (!runs.length || runs[runs.length - 1].tag !== tag) runs.push({ tag, t: e.t });
  }
  const seen = new Map();
  for (const r of runs) seen.set(r.tag, (seen.get(r.tag) || 0) + 1);
  const repeatedTags = [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t);

  const windows = new Map();
  for (let i = 0; i < runs.length; i++) {
    if (windows.has(runs[i].tag)) continue;      // first run wins; repeats are reported
    const bounded = i + 1 < runs.length;
    windows.set(runs[i].tag, {
      from: runs[i].t,
      to: bounded ? runs[i + 1].t : Number.POSITIVE_INFINITY,
      bounded,
    });
  }

  // The per-request attestations the driver hands the gateway (see
  // observation.mjs). Keyed by tag; a tag with more than one is reported by
  // the caller rather than silently reduced.
  const observations = new Map();
  for (const e of rows) {
    if (!e || !e.observation || typeof e.observation !== "object") continue;
    const tag = typeof e.observation.tag === "string" ? e.observation.tag : null;
    if (!tag) continue;
    if (!observations.has(tag)) observations.set(tag, []);
    observations.get(tag).push({ loggedAt: e.t, seq: e.seq, ...e.observation });
  }

  return {
    present, rows, windows, repeatedTags, observations,
    unparseable: p.unparseable, rawLines: p.rawLines,
    file, rel: path.relative(out, file),
  };
}

/** The instrument's own log for one cell, parsed once and cached.
 *
 *  `rawLines` is the denominator for `events.length` and `unparseable` is the
 *  difference between them; before round 7 the difference was thrown away
 *  inside `parseJsonl` and `events.length` was published as though it were the
 *  size of the file. */
export function instrumentLog(out, schema, cellId, cache) {
  const key = `${schema}/${cellId}`;
  if (cache && cache.has(key)) return cache.get(key);
  const file = path.join(out, "instr", `${schema}-${cellId}.jsonl`);
  const p = parseJsonlFile(file);
  const events = p.rows;
  const loaded = events.some((e) => e && e.kind === "instrument.loaded");
  const rec = {
    present: p.present, file, rel: path.relative(out, file), events, loaded,
    // `eventLineNos[i]` is the physical line `events[i]` was read from, so a
    // refusal about one event can name the line a reader must open.
    eventLineNos: p.lineNos,
    unparseable: p.unparseable, rawLines: p.rawLines,
  };
  if (cache) cache.set(key, rec);
  return rec;
}

/* ROUND-5 AUDIT. This was `${e.seq}|${e.t}|${e.kind}` — the same three fields
 * the gateway's attestation hashed, and between them they left `detail`, which
 * is the entire content of the evidence, bound by nothing. `eventIdentity`
 * adds a canonical digest of the detail, so:
 *
 *   - `diffEventSets` now calls two events "the same event" only when they say
 *     the same thing happened, not merely when they are labelled alike;
 *   - `attributeEvents` matches a log line to a DECLARED boot event on the same
 *     terms, so a boot line whose detail was rewritten in one copy becomes
 *     UNATTRIBUTED rather than silently absorbed.
 *
 * Derived from observation.mjs so the observer-side comparison and the
 * gateway-side attestation cannot key on different things — which is exactly
 * how they both came to key on too little. */
export const eventKey = (e) => JSON.stringify(eventIdentity(e));

export function eventsInWindow(events, win) {
  if (!win) return [];
  return events.filter((e) =>
    typeof e.t === "number" && e.t >= win.from && e.t < win.to);
}

/**
 * What the instrument's own log says that the driver's transcription does not,
 * and the reverse. Matched on the instrument's own `seq`+`t`+`kind`, which the
 * driver copies verbatim.
 */
export function diffEventSets(observerEvents, driverEvents) {
  const o = new Map();
  for (const e of observerEvents) o.set(eventKey(e), e);
  const d = new Map();
  for (const e of Array.isArray(driverEvents) ? driverEvents : []) d.set(eventKey(e), e);
  const onlyObserver = [...o.keys()].filter((k) => !d.has(k)).map((k) => o.get(k));
  const onlyDriver = [...d.keys()].filter((k) => !o.has(k)).map((k) => d.get(k));
  return { onlyObserver, onlyDriver };
}

/**
 * ADV-1. ACCOUNT FOR EVERY LINE OF THE IMAGE'S OWN LOG, not only the ones that
 * fall inside a request.
 *
 * `eventsInWindow` answers "what did the image do while this request was in
 * flight". It says nothing about the ~89% of each cell's timeline that is not
 * a request window, and an auditor put three real broker calls there and got a
 * certifying PASS. This answers the complementary question: is there anything
 * in this file that NOTHING in this run explains?
 *
 * Exactly two things account for an event:
 *
 *   boot     it is in the boot snapshot the cell result declares, matched on
 *            the instrument's own seq|t|kind. `instrumentEvidence` already
 *            requires the converse — every declared boot event must be in this
 *            file — so together the two pin the boot prefix in both
 *            directions, and a line inserted among the boot events with a
 *            duplicated seq is caught here rather than waved through by a
 *            `seq > max(bootSeq)` test.
 *   window   it falls inside exactly one BOUNDED request window. `#witness`
 *            and `#idle` are the driver's own bookends — the second of which
 *            is the ~15 s hole the attack lived in — so a tag that is not
 *            `<cell>#<digits>` is rejected as a window here even if a cell
 *            result names it as one.
 *
 * Anything else is unattributed. Unattributed is not absent.
 *
 * @param {object[]} events        every parsed line of instr/<schema>-<cell>.jsonl
 * @param {object[]} bootEvents    the cell result's declared boot snapshot
 * @param {Array<[string, object|undefined]>} taggedWindows  this cell's
 *        [requestTag, gatewayWindow] pairs, in the cell result's own order
 */
/* THE BOOT BUCKET IS IDENTIFIED, AND ALSO JUDGED — BY AN ALLOW-LIST.
 *
 * `boot` accounts for an event; on its own it does not say the event was
 * innocent. Nothing in this harness decides a CLAIM from a boot event — the
 * claims are per-request — so before this the boot snapshot was a place where
 * an outbound call sat, fully attributed, and no check looked at it. It takes
 * two edits (the instrument log and the cell result's `bootEvents`) to put one
 * there deliberately, and none at all if the image really does it.
 *
 * THE FIRST VERSION OF THIS JUDGE WAS A DENY-LIST, AND A ROUND-5 AUDIT WALKED
 * THROUGH IT TWICE, both times to a full certifying PASS (rc=0, banner printed,
 * `noBrokerCall: 480 satisfied, 0 violated`) over a log recording
 * `POST https://paper-api.alpaca.markets/v2/orders`:
 *
 *   1. It enumerated four network kinds — fetch, socket.connect, tls.connect,
 *      dns.lookup — and instrument.cjs:213-234 emits four more,
 *      `node:{http,https}.{request,get}`, which claims.mjs has always counted
 *      as egress. The same call, recorded under the kind the `https` module
 *      path produces, was not a network kind here.
 *   2. It read `detail.hostClass` — a field the writer of the record chooses —
 *      and refused only broker/other/unknown. One word changed to `loopback`
 *      and a `fetch` whose own `host` field still said
 *      paper-api.alpaca.markets became permitted.
 *
 * Both are the same mistake: a check narrower than the thing it checks, failing
 * OPEN on the case nobody enumerated. So the judge is now an ALLOW-list of the
 * kinds the instrument can emit before a request exists, and it consults no
 * self-reported classification at all. A kind nobody thought of — including one
 * a future instrument.cjs gains — refuses instead of passing, which is the
 * direction this harness must fail in. The message still names egress
 * specifically, using the SINGLE shared list in claims.mjs, so the refusal says
 * what it found rather than only that the kind was unexpected.
 *
 * This remains an INCLUSION filter over an already-exhaustive partition: it can
 * only add refusals, never excuse an event, which is why a kind filter is
 * allowed here and refused for the unattributed set.
 *
 * MEASURED across the four genuine certifying runs (7da1ca7f, 21e6a343,
 * 55c8d4d3, 3085a474): 2385 boot-attributed events, exactly
 * `instrument.coverage` 192 / `instrument.loaded` 192 / `instrument.ready` 192
 * / `env.read` 1809, and 0 of anything else. `instrument.error` is permitted
 * although it was not observed: it is the instrument reporting its own failure
 * to patch something, and refusing the diagnostic would hide the diagnosis.
 */
const BOOT_PERMITTED_KINDS = new Set([
  "instrument.loaded", "instrument.ready", "instrument.coverage",
  "instrument.error", "env.read",
]);
function bootEventProblem(e) {
  const kind = e && typeof e.kind === "string" ? e.kind : "(no kind)";
  if (BOOT_PERMITTED_KINDS.has(kind)) return null;
  if (EGRESS_KINDS.has(kind)) {
    return `an outbound ${kind} at container start, which no claim in this harness is decided from ` +
           `and which the boot snapshot would otherwise absorb silently — note that the host class ` +
           `printed above is the RECORD'S OWN and is not what this refusal rests on`;
  }
  if (REQUEST_ONLY_KINDS.has(kind)) {
    return `${kind} cannot happen before the first request: there is no body to read`;
  }
  return `${kind} is not one of the kinds a boot snapshot may contain ` +
         `(${[...BOOT_PERMITTED_KINDS].join(", ")}); an unrecognised kind in the one bucket no claim ` +
         `reads is refused rather than admitted`;
}

export function attributeEvents(events, bootEvents, taggedWindows) {
  const bootKeys = new Set(
    (Array.isArray(bootEvents) ? bootEvents : []).map(eventKey));
  const windows = [];
  for (const [tag, win] of taggedWindows) {
    if (typeof tag !== "string" || !REQUEST_TAG.test(tag)) continue;
    if (!win || !win.bounded) continue;
    windows.push({ tag, win });
  }
  const out = {
    boot: 0, inWindow: 0, windowsUsable: windows.length,
    multiWindow: [], unattributed: [], bootKinds: {}, bootProblems: [],
  };
  for (const e of Array.isArray(events) ? events : []) {
    if (bootKeys.has(eventKey(e))) {
      out.boot++;
      const k = typeof e.kind === "string" ? e.kind : "(no kind)";
      out.bootKinds[k] = (out.bootKinds[k] || 0) + 1;
      const problem = bootEventProblem(e);
      if (problem) out.bootProblems.push({ event: e, problem });
      continue;
    }
    const hits = windows.filter(({ win }) =>
      typeof e.t === "number" && e.t >= win.from && e.t < win.to);
    if (hits.length === 1) { out.inWindow++; continue; }
    if (hits.length > 1) {
      out.multiWindow.push({ event: e, tags: hits.map((h) => h.tag) });
      continue;
    }
    out.unattributed.push(e);
  }
  return out;
}

/**
 * ROUND-5 AUDIT. THE SAME QUESTION, ASKED OF THE SECOND OBSERVER.
 *
 * `attributeEvents` accounts for every line of the IMAGE's log. Nothing
 * accounted for the lines of the GATEWAY's log — the observer that exists
 * precisely because the instrument runs inside the thing under test and can
 * therefore lie or fall silent about itself.
 *
 * The gateway's log was read in exactly two narrow ways: `sinkByCell()` buckets
 * it by cell tag and `verdict.mjs` then asks for `sinkMap.get(tag)` where `tag`
 * is always `<cell>#<n>`. Entries logged under `<cell>#witness`, `<cell>#idle`
 * or `(unset)` — the 89% of the timeline ADV-1 measured, container teardown,
 * the next container's boot, and the gap either side of the request burst —
 * were parsed, bucketed and read by nothing. `noPostgRESTCall`, `noAuthCall`
 * and `noDatabaseCall` were decided as though that part of the log did not
 * exist.
 *
 * MEASURED: a `GET /rest/v1/accounts` and a `GET /auth/v1/user`, in the exact
 * shape sink.mjs:104/311 writes, inserted in place under one cell's `#idle`
 * tag, with NOTHING ELSE TOUCHED — no instrument event, no cell result —
 * produced a full certifying PASS. The `#witness` variant did too. Under a
 * REQUEST tag the same two entries are refused (rc=1, FINDING), which is the
 * positive control that the reading path works and the complement is the hole.
 *
 * So: every entry the gateway logged that is NOT the harness's own control
 * traffic must fall under a request tag that some cell result in this
 * generation claims. An entry anywhere else is one nothing in this run
 * accounts for. `kind` is assigned by the gateway itself (sink.mjs:175-181,
 * from the request path) and not by the caller, so `harness` cannot be claimed
 * by a request to /rest/v1.
 *
 * MEASURED on the four genuine certifying runs: 3960 gateway entries, 3960 of
 * them harness control traffic — `/__canary/started` 2, `/__canary/health` 2,
 * `/__canary/generation` 50, `/__canary/cell` 576 — and 0 of any other kind,
 * so the exclusion below removes nothing a frozen run produces and the count
 * is published either way.
 *
 * THE `/__canary/observe` FIGURE, CORRECTED (R7-5). This note used to gloss
 * the composition as `/__canary/observe` 480 per pair of generations, which is
 * true of THREE of the four runs and not of the fourth. Re-measured per run:
 * 7da1ca7f, 21e6a343 and 55c8d4d3 carry 1110 rows each, of which 480 are
 * /__canary/observe; 3085a474 carries 630 rows and ZERO observe rows, because
 * it predates the request attestation entirely. 3 x 1110 + 630 = 3960, so the
 * TOTAL is right and the per-run gloss was not. Related and also disclosed
 * where the aggregates are published: all four of these corpora are at request
 * attestation OBSERVATION_VERSION 1 or older, which is the version
 * tests/run-all.sh and tests/k14 now REFUSE as non-forward-portable — so none
 * of the directories these numbers came from can be re-verified by the harness
 * as it stands. They are historical measurements, not results this checkout
 * reproduces on demand.
 *
 * THE EXEMPTION IS DERIVED FROM THE PATH, NOT READ OFF THE ROW. Writing
 * `"kind":"harness"` beside `"path":"/rest/v1/accounts"` would otherwise buy
 * the exemption with one word, which is the round-5 mistake all over again —
 * a decision resting on a field the writer of the record chooses. sink.mjs's
 * own `classify()` is five deterministic lines over the request path and is
 * reproduced here; a row whose declared kind disagrees with its path is
 * refused as self-contradicting rather than resolved in either direction.
 *
 * @param {object[]} rows        every parsed line of sink-<schema>.jsonl
 * @param {Set<string>} claimedTags  every `<cell>#<n>` some cell result claims
 */
/* THE CLASSIFIER LIVES IN claims.mjs AND IS RE-EXPORTED HERE (round-8 audit).
 *
 * This file used to keep its own five-line copy of sink.mjs's classify(), and
 * claims.mjs kept no copy at all — it read the row's `kind` instead. So the
 * verdict derived the class here, published the derivation, and then decided
 * the claim from the label: deleting the `kind` field from one gateway row
 * recording GET /rest/v1/accounts inside a claimed request moved
 * gatewayHarnessRows 555 -> 554 and gatewayRowsInAClaimedRequest 0 -> 1 and
 * still printed a certifying PASS with noPostgRESTCall 480 satisfied / 0
 * violated. There is now ONE classifier, in the file that also names which
 * claim reads which class, and both this attribution and every claim decision
 * call it. See claims.mjs GATEWAY_PATH_CLASSES / GATEWAY_CLASS_READERS. */
export { classifyGatewayPath };

/* ==========================================================================
 * ROUND 9. THE HARNESS'S OWN CONTROL TRAFFIC MUST ACCOUNT FOR ITSELF TOO.
 *
 * `harness` is the one class GATEWAY_CLASS_READERS maps to NO claim, and until
 * this round a row of that class was counted and skipped: `if (derived ===
 * "harness") { out.harness++; continue; }`. The exemption was derived from the
 * path, which is what stops a /rest/v1 row buying it with a word — but it was
 * still an exemption granted to a PATH PREFIX rather than to the driver, and
 * the scope document described the class as "the driver's own /__canary
 * control traffic", a property of WHO that nothing checked.
 *
 * MEASURED, against the code as shipped before this round. The recording
 * gateway serves /__canary/{cell,health,generation,observe} to anyone who can
 * open a socket to it, with no credential of any kind, and the image under
 * test is on that network by construction (run.sh gives it
 * SUPABASE_SERVER_URL=http://nt-canary-sink:8000). A throwaway container on an
 * --internal network with the real sink.mjs got:
 *
 *     POST /__canary/cell        -> 200 {"cell":"IMAGE-CHOSE-THIS-TAG"}
 *     GET  /__canary/health      -> 200  (the gateway ran a query for it)
 *     GET  /__canary/generation  -> 200  (the gateway ran the catalogue query
 *                                         and handed back the fingerprint)
 *     POST /__canary/observe     -> 200 {"recorded":true}
 *     GET  /rest/v1/accounts     -> 401  (the data plane needs a token; the
 *                                         control plane does not)
 *
 * and the gateway wrote each of them into its own log as kind "harness". With
 * one of those REAL rows spliced into a genuine 48-cell certifying corpus
 * inside a claimed request window, `verdict.mjs` returned rc=0, the PASS
 * banner, hardFailures 0, `noUnexpectedNetworkCall 480 satisfied / 0 violated`
 * and `noDatabaseCall 480 satisfied / 0 violated`. The control — the same
 * client's /rest/v1/accounts row, a 401 that reached no data — was rc=1
 * FINDING. A refused data-plane attempt was a violation; an accepted
 * control-plane call that ran SQL was not.
 *
 * SO THE HARNESS ROWS ARE NOW ACCOUNTED, exactly the way every other bucket in
 * this harness has had to become accounted: not by trusting a label, but by
 * requiring each row to be one the driver's protocol produces. The protocol is
 * completely regular and was measured over both fixtures (48-cell and 1-cell,
 * 555 and 26 rows): eight (tag-class, path, method) shapes, no (tag, path)
 * pair twice.
 *
 * WHAT IS STILL NOT DISTINGUISHED, stated because it is the residue and not a
 * property: before the driver announces the first cell tag of a generation the
 * gateway's tag is "(unset)", and run.sh's own readiness probe uses
 * GET /__canary/health in that window. An image that calls /__canary/health
 * while booting the first cell lands in the same bucket and is indistinguishable
 * from the probe. /__canary/generation and /__canary/started are capped at one
 * row each there, so the schema-fingerprint read is closed; only the `select 1`
 * of /__canary/health remains, and only in that window. Closing it needs the
 * gateway to require a per-run control credential the image does not hold,
 * which changes the recorded shape and therefore needs a fresh matrix.
 * ========================================================================== */

/** Which bookend of the driver's protocol a gateway row's tag belongs to. */
export function gatewayTagClass(tag) {
  if (tag === "(unset)") return "unset";
  if (/#witness$/.test(String(tag))) return "witness";
  if (/#idle$/.test(String(tag))) return "idle";
  if (REQUEST_TAG.test(String(tag))) return "request";
  return "other";
}

/** (tag class) -> (path -> the method the driver's protocol uses for it).
 *  Every /__canary row must match one of these, and no other row may exist.
 *  Generated from nothing: it is a pin, and it is inside TRUSTED_DIGEST. */
export const HARNESS_PROTOCOL = {
  // Before any cell tag is announced: the gateway's own boot row, run.sh's
  // readiness probe and run.sh's one generation check.
  unset:   { "/__canary/started": "-", "/__canary/health": "GET", "/__canary/generation": "GET" },
  // Per cell, the driver's bookends.
  witness: { "/__canary/cell": "POST", "/__canary/generation": "GET" },
  idle:    { "/__canary/cell": "POST" },
  // Per request: the tag announcement and the request attestation.
  request: { "/__canary/cell": "POST", "/__canary/observe": "POST" },
  // A tag shaped like none of the above is not a tag this protocol produces.
  other:   {},
};
/** Paths that may legitimately repeat inside one tag. Only the readiness poll:
 *  run.sh retries GET /__canary/health until the gateway reaches the database,
 *  and a retry that got a 500 is a real row. Everything else is once. */
const HARNESS_REPEATABLE = new Set(["unset|/__canary/health"]);

export function attributeGatewayRows(rows, claimedTags, bookendTags) {
  const out = {
    total: 0, harness: 0, inClaimedRequest: 0, unaccounted: [], mislabelled: [],
    withoutADeclaredKind: 0, byClass: {},
    harnessAccounted: 0, harnessUnaccounted: [], harnessByShape: {},
  };
  const seenHarness = new Map();
  const bookends = bookendTags instanceof Set ? bookendTags : null;
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!e || typeof e !== "object") continue;
    out.total++;
    const derived = classifyGatewayPath(e.path);
    out.byClass[derived] = (out.byClass[derived] || 0) + 1;
    /* A row with no `kind` at all is published rather than refused. It is the
     * R8-1 attack shape, and the point of the round-8 repair is that it no
     * longer BUYS anything: the class comes from the path, so the row is
     * judged exactly as if it had labelled itself honestly, and the run reports
     * a FINDING about the image rather than a refusal about the artefact. The
     * count is here so a reader can still see that a row arrived unlabelled. */
    if (typeof e.kind !== "string") out.withoutADeclaredKind++;
    else if (e.kind !== derived) out.mislabelled.push({ row: e, derived });
    const tag = typeof e.cell === "string" ? e.cell : "";
    if (derived === "harness") {
      out.harness++;
      const tc = gatewayTagClass(tag);
      const shape = `${tc}|${String(e.path)}|${String(e.method)}`;
      out.harnessByShape[shape] = (out.harnessByShape[shape] || 0) + 1;
      const wantMethod = Object.prototype.hasOwnProperty.call(HARNESS_PROTOCOL[tc] || {}, String(e.path))
        ? HARNESS_PROTOCOL[tc][String(e.path)] : null;
      let why = null;
      if (wantMethod === null) {
        why = `the driver's protocol issues no ${String(e.path)} under a ${tc} tag`;
      } else if (String(e.method) !== wantMethod) {
        why = `the driver issues ${String(e.path)} as ${wantMethod} under a ${tc} tag, not ${String(e.method)}`;
      } else if (tc !== "unset" && bookends && !bookends.has(tag) && !claimedTags.has(tag)) {
        why = `the tag ${JSON.stringify(tag)} is not one this run's cell results account for`;
      } else {
        const key = `${tc}|${String(e.path)}`;
        const dupKey = `${tag}|${String(e.path)}`;
        if (!HARNESS_REPEATABLE.has(key) && seenHarness.has(dupKey)) {
          why = `a second ${String(e.path)} under the tag ${JSON.stringify(tag)}; the driver issues it once`;
        }
        seenHarness.set(dupKey, true);
      }
      if (why) out.harnessUnaccounted.push({ row: e, why });
      else out.harnessAccounted++;
      continue;
    }
    if (REQUEST_TAG.test(tag) && claimedTags.has(tag)) { out.inClaimedRequest++; continue; }
    out.unaccounted.push(e);
  }
  return out;
}

/** A one-line description of a gateway entry, for the same reason. */
export function describeGatewayRow(e) {
  const bits = [`cell=${JSON.stringify(e && e.cell)}`];
  if (e && e.kind) bits.push(`kind=${e.kind}`);
  if (e && e.method) bits.push(e.method);
  if (e && e.path) bits.push(String(e.path) + (e.query || ""));
  if (e && e.status !== undefined) bits.push(`status=${e.status}`);
  return `seq=${e && e.seq} t=${e && e.t} ${bits.join(" ")}`;
}

/** A one-line description of an event, for a failure message that says what
 *  was seen rather than only how many. */
export function describeEvent(e) {
  const d = (e && e.detail) || {};
  const bits = [];
  if (d.hostClass) bits.push(`hostClass=${d.hostClass}`);
  if (d.host || d.hostname) bits.push(`host=${d.host || d.hostname}`);
  if (d.pathClass) bits.push(`pathClass=${d.pathClass}`);
  if (d.name) bits.push(`name=${d.name}`);
  if (d.method) bits.push(`method=${d.method}`);
  if (d.port) bits.push(`port=${d.port}`);
  return `seq=${e.seq} t=${e.t} ${e.kind}${bits.length ? ` (${bits.join(" ")})` : ""}`;
}
