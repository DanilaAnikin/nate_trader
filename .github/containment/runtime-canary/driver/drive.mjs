/* ==========================================================================
 * drive.mjs — issue one matrix cell against the image under test
 *
 * Runs as a container on the harness's `--internal` network, which is the only
 * network the image under test is attached to. It is invoked once per cell —
 * one combination of the three freeze environment variables — because those
 * variables are given to the container at start, and re-reading them from
 * inside would be a test of the harness's own mutation rather than of a
 * deployment.
 *
 * For every request it records:
 *   - the exact status, the response headers that carry the refusal identity,
 *     and a truncated body;
 *   - every instrument event the image emitted while the request was in
 *     flight (requests are issued strictly one at a time, so the window
 *     between two readings of the event log belongs to exactly one request);
 *   - the delta of every V8 coverage marker over the same window.
 *
 * It asserts nothing. Verdicts belong in run.sh, where the controls that make
 * an absence believable have already run.
 * ========================================================================== */

import fs from "node:fs";
import { observationFields, observationDigest } from "./observation.mjs";

const APP = process.env.NT_APP_BASE || "http://nt-canary-app:3000";
const CTL = process.env.NT_CTL_BASE || "http://nt-canary-app:3999";
const SINK = process.env.NT_SINK_BASE || "http://nt-canary-sink:8000";
const CELL = process.env.NT_CELL || "unnamed-cell";
const OUT = process.env.NT_OUT || "/out/cell.json";
const PLAN = process.env.NT_PLAN || "/canary/plan.json";
const COOKIE_NAME = process.env.NT_COOKIE_NAME || "sb-canary-auth-token";
const COOKIE_VALUE = process.env.NT_COOKIE_VALUE || "";
// WHICH MIGRATION GENERATION, AND WHICH RUN (audit findings B1 and B3).
//
// The cell result used to state which CELL it was and nothing else. The
// generation lived only in the filename prefix that verdict.mjs supplied
// itself, so one generation's twenty-four files under the other generation's
// names satisfied every identity check — and a directory assembled from two
// different run.sh invocations was indistinguishable from one run.
//
// `NT_SCHEMA` is the driver's own statement of the generation, the same kind of
// statement as `cell`; on its own it is only as good as the harness that set
// it. `NT_RUN_NONCE` ties every cell of the verdict to ONE run. Neither is the
// load-bearing witness: that is `dbWitness` below, read out of the running
// database by the recording gateway.
const SCHEMA = process.env.NT_SCHEMA || "";
const RUN_NONCE = process.env.NT_RUN_NONCE || "";

const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));

const BODIES = {
  // Metadata-only: the credential-rotation branch of PATCH would call Alpaca
  // first and never reach a Vault wrapper, so it would make property (B)
  // untestable on the one endpoint that can prove it.
  "PATCH /api/accounts/:id": { nickname: "canary-mutation-attempt" },
  "DELETE /api/accounts/:id": null,
  "POST /api/accounts/:id/verify": {},
  // Deliberately reaches the broker path in an unfrozen image: it is the
  // positive control for "no broker call".
  "POST /api/accounts": {
    nickname: "canary-created-account",
    mode: "paper",
    apiKey: "NOT-A-REAL-ALPACA-KEY-CANARY",
    apiSecret: "NOT-A-REAL-ALPACA-SECRET-CANARY",
  },
  "PATCH /api/profile": { display_name: "canary-mutation-attempt" },
};

function bodyKeyFor(req) {
  return `${req.method} ${req.template}`;
}

async function ctlJson(path) {
  try {
    const r = await fetch(`${CTL}${path}`, { signal: AbortSignal.timeout(10000) });
    return { ok: r.ok, status: r.status, body: await r.json() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function setCell(tag) {
  try {
    await fetch(`${SINK}/__canary/cell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cell: tag }),
      signal: AbortSignal.timeout(10000),
    });
    return true;
  } catch {
    return false;
  }
}

/* ATTEST ONE REQUEST TO THE RECORDING GATEWAY (audit findings B and C).
 *
 * Two forgeries certified a PASS by rewriting only the cell-result files: one
 * generation's results filed under the other's names, and one cell's results
 * pasted into twenty-three others. Both worked because the cell result was the
 * ONLY copy of what each request observed, so a copy of it was
 * indistinguishable from the truth.
 *
 * The canonical description of every request now goes to the gateway the
 * moment the request finishes, and the gateway writes it into
 * `sink-<schema>.jsonl`, a host bind mount owned by a different container.
 * `verdict.mjs` recomputes the description from the cell result and requires
 * the two to be equal. This does not defend against a driver that lies while
 * it runs — it defends against an artefact directory edited afterwards, which
 * is what B and C were. */
async function attest(observation, digest) {
  try {
    const r = await fetch(`${SINK}/__canary/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...observation, digest }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function sinkJson(path) {
  try {
    const r = await fetch(`${SINK}${path}`, { signal: AbortSignal.timeout(20000) });
    return { ok: r.ok, status: r.status, body: await r.json() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

const results = [];
let lastSeq = 0;

// The generation witness, taken BEFORE the first request and tagged to this
// cell so the gateway's own log records it under this cell too. The reply is
// recorded verbatim; this driver does not compute it and cannot forge it
// without also forging a file written by another container.
await setCell(`${CELL}#witness`);
const witnessReply = await sinkJson("/__canary/generation");
const dbWitness = witnessReply.ok && witnessReply.body && witnessReply.body.fingerprint
  ? witnessReply.body
  : { error: witnessReply.error || `gateway returned ${witnessReply.status}`,
      body: witnessReply.body || null };

// Where the instrument's event counter already is: everything before this
// belongs to boot, not to a request.
const boot = await ctlJson("/events?since=0");
if (boot.ok) lastSeq = boot.body.seq;
const bootEvents = boot.ok ? boot.body.events : [];
const envReport = await ctlJson("/env");

// Whether the in-process instrument is there AT ALL, decided once, from its
// own boot record rather than from the absence of events.
//
// This is the field whose absence produced the defect this driver is being
// rewritten for: when the instrument was not loaded in a container, the
// claims it feeds did not fail — they vanished, and the row printed clean.
// A sensor that is not present must be REPORTED not present, per request,
// so the schema can turn it into an `indeterminate` record.
const instrumentLoaded =
  boot.ok && Array.isArray(bootEvents) &&
  bootEvents.some((e) => e && e.kind === "instrument.loaded");
const instrumentAbsentReason = !boot.ok
  ? `control surface unreachable (${boot.error || "status " + boot.status})`
  : (instrumentLoaded ? null : "no instrument.loaded event in the boot window");

for (const req of plan.requests) {
  const tag = `${CELL}#${req.id}`;
  const sinkTagged = await setCell(tag);

  const marksBefore = await ctlJson("/marks");
  const t0 = Date.now();

  const key = bodyKeyFor(req);
  const payload = Object.prototype.hasOwnProperty.call(BODIES, key) ? BODIES[key] : {};
  const headers = { "X-Canary-Cell": tag };
  let body;
  if (payload !== null && req.method !== "GET" && req.method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  if (req.authenticated && COOKIE_VALUE) {
    headers["Cookie"] = `${COOKIE_NAME}=${COOKIE_VALUE}`;
  }

  let res = null;
  let error = null;
  try {
    const r = await fetch(`${APP}${req.url}`, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    res = {
      status: r.status,
      headers: {
        "content-type": r.headers.get("content-type"),
        "x-artifact-role": r.headers.get("x-artifact-role"),
        "x-writes-enabled": r.headers.get("x-writes-enabled"),
        "retry-after": r.headers.get("retry-after"),
        "cache-control": r.headers.get("cache-control"),
        location: r.headers.get("location"),
      },
      bodyBytes: text.length,
      body: text.slice(0, 600),
    };
  } catch (e) {
    error = String(e.message || e);
  }

  const t1 = Date.now();
  const evs = await ctlJson(`/events?since=${lastSeq}`);
  const during = evs.ok ? evs.body.events : [];
  if (evs.ok) lastSeq = evs.body.seq;
  const marksAfter = await ctlJson("/marks");

  // `Profiler.takePreciseCoverage` resets V8's execution counters, so the
  // reading taken AFTER the request already covers exactly the window since
  // the one taken before it. Subtracting the two — which is what this did
  // first — produced negative "deltas" for anything that ran in an earlier
  // window, and hid everything that ran in this one.
  const markDelta = {};
  if (marksAfter.ok && marksAfter.body.marks) {
    for (const [k, v] of Object.entries(marksAfter.body.marks)) if (v !== 0) markDelta[k] = v;
  }

  const marksReadable = Boolean(marksBefore.ok && marksAfter.ok && marksAfter.body.marks);
  const routeIndexed = marksAfter.ok && marksAfter.body ? (marksAfter.body.routeChunksIndexed || 0) : 0;
  const routeExec = marksAfter.ok && marksAfter.body && typeof marksAfter.body.routeTotal === "number"
    ? marksAfter.body.routeTotal
    : null;

  // Every sensor is reported, live or not, for EVERY request. A sensor that
  // cannot be read is a fact about this request, not a reason to say less
  // about it.
  const sensors = {
    driver:   { live: true },
    response: res ? { live: true } : { live: false, reason: error || "no response" },
    instrument: instrumentLoaded && evs.ok
      ? { live: true }
      : { live: false, reason: instrumentAbsentReason || `event read failed (${evs.error || "status " + evs.status})` },
    coverage: marksReadable
      ? { live: true }
      : { live: false, reason: marksAfter.ok
          ? String((marksAfter.body && marksAfter.body.error) || "no marks in the response")
          : `marks unreadable (${marksAfter.error || "status " + marksAfter.status})` },
    routeCoverage: marksReadable && routeIndexed > 0 && routeExec !== null
      ? { live: true }
      : { live: false, reason: !marksReadable ? "coverage unavailable"
          : routeIndexed === 0 ? "no route chunks were indexed" : "no routeTotal in the reading" },
    sink: sinkTagged
      ? { live: true }
      : { live: false, reason: "the recording gateway did not acknowledge this request's cell tag" },
  };

  const entry = {
    id: req.id,
    cellTag: tag,
    sinkTagged,
    method: req.method,
    url: req.url,
    template: req.template,
    file: req.file,
    authenticated: req.authenticated,
    sentBody: body !== undefined,
    // The two ends of the request, absolute rather than only as a duration.
    // `ms` alone said how long a request took and nothing about WHEN, so a
    // request observation carried no timestamp that could be compared with the
    // gateway's window for its tag — which is what made B and C copyable.
    t0,
    t1,
    ms: t1 - t0,
    response: res,
    error,
    events: during,
    markDelta,
    marksReadable,
    routeIndexed,
    routeExec,
    sensors,
  };

  const fields = observationFields(RUN_NONCE, SCHEMA, CELL, entry);
  const digest = observationDigest(fields);
  entry.observationDigest = digest;
  entry.observationAttested = await attest(fields, digest);
  if (!entry.observationAttested) {
    entry.sensors.sink = { live: false, reason: "the recording gateway did not record this request's observation" };
  }

  results.push(entry);
}

await setCell(`${CELL}#idle`);

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      cell: CELL,
      schema: SCHEMA,
      runNonce: RUN_NONCE,
      dbWitness,
      env: plan.env,
      bootEvents,
      instrumentLoaded,
      instrumentAbsentReason,
      instrumentEnv: envReport.ok ? envReport.body : { error: envReport.error },
      results,
    },
    null,
    2,
  ),
);
process.stdout.write(
  `${CELL}: ${results.length} requests, schema=${SCHEMA || "(unset)"}, ` +
  `dbWitness=${dbWitness.fingerprint || `ERROR ${dbWitness.error}`}\n`);
