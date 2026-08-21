/* ==========================================================================
 * claims.mjs — the CLOSED schema every driven request must satisfy
 *
 * WHAT WENT WRONG BEFORE
 * ----------------------
 * The matrix used to be a list of failure strings. A claim appeared in the
 * report only when it was VIOLATED, and a violation could only be found from
 * an event the in-process instrument had emitted. So when the instrument was
 * not loaded in a container, `noBodyParse`, `noSupabaseClient` and
 * `noBrokerCall` did not fail and did not warn — they silently ceased to
 * exist, and the row printed a green dash. The verifier demonstrated exactly
 * that: a request that provably parsed a body and provably constructed a
 * Supabase client lost both claims and the cell was reported clean.
 * `verdict.mjs` never read `marksReadable`, `instrumentEnv` or `bootEvents`,
 * the three fields that would have revealed it.
 *
 * THE FIX IS A SCHEMA, NOT ANOTHER CHECK
 * --------------------------------------
 * Every driven request must produce EXACTLY ONE record for EVERY claim in
 * `REQUIRED_CLAIMS`. A record carries a status from a closed set and names the
 * sensors it was decided from, each with its own liveness. A claim whose
 * sensors were not all live is `indeterminate` — never `satisfied`, never
 * absent. Missing, duplicated, malformed, unknown, unexecuted, skipped and
 * empty are all hard failures of the COMPLETENESS check, which is evaluated
 * before any verdict is rendered.
 *
 * The consequence that matters: REMOVING A SENSOR NOW BREAKS THE RUN. It can
 * no longer make a claim disappear, because the claim's absence is itself the
 * thing the completeness check is looking for.
 * ========================================================================== */

/** The complete, closed set. Order is the report order. */
export const REQUIRED_CLAIMS = [
  "requestDriven",
  "routeMatched",
  "expectedResponseClass",
  "refusalIdentity",
  "responseStatus",
  "proxyRefusedBeforeAuth",
  "handlerNotReached",
  "noAuthCall",
  "noBodyParse",
  "noSupabaseClient",
  "noPostgRESTCall",
  "noDatabaseCall",
  "noVaultCall",
  "noBrokerCall",
  "noUnexpectedNetworkCall",
  "canaryObservationComplete",
];

export const CLAIM_STATUSES = ["satisfied", "violated", "indeterminate"];

/** Which observer each claim is decided from. A claim cannot be decided
 *  without every sensor it names being live. */
export const CLAIM_SENSORS = {
  requestDriven:             ["driver"],
  routeMatched:              ["driver", "response"],
  expectedResponseClass:     ["driver", "response"],
  refusalIdentity:           ["driver", "response"],
  responseStatus:            ["driver", "response"],
  proxyRefusedBeforeAuth:    ["response", "instrument", "sink"],
  handlerNotReached:         ["routeCoverage"],
  noAuthCall:                ["instrument", "sink"],
  noBodyParse:               ["instrument"],
  noSupabaseClient:          ["instrument", "coverage"],
  noPostgRESTCall:           ["instrument", "sink"],
  noDatabaseCall:            ["instrument", "sink"],
  noVaultCall:               ["canary", "sink"],
  noBrokerCall:              ["instrument", "coverage"],
  noUnexpectedNetworkCall:   ["instrument"],
  canaryObservationComplete: ["canary", "sensorRunner"],
};

export const ALL_SENSORS = [
  "driver", "response", "instrument", "coverage", "routeCoverage",
  "sink", "canary", "sensorRunner",
];

/** Hosts a frozen artifact may legitimately talk to inside the harness. */
const ALLOWED_HOST_CLASSES = new Set(["supabase-sink", "loopback"]);

/** The recording gateway's container name, pinned in one place. verdict.mjs's
 *  §3c control imports this rather than keeping its own copy. */
export const HARNESS_SINK_HOST = "nt-canary-sink";

/* ==========================================================================
 * THE DATA PLANE IS A CLASSIFICATION OF THE PATH, AND EVERY CLASS IS READ
 * (round-8 audit, R8-1 and R8-2)
 *
 * WHAT WENT WRONG BEFORE, TWICE, IN ONE PLACE
 * -------------------------------------------
 * (R8-1) The gateway buckets below were `sink.filter((e) => e.kind === "auth")`
 * and friends — the class READ OFF THE ROW. The verdict was already deriving
 * the right class from the path one screen away (observers.mjs
 * attributeGatewayRows) and PUBLISHING the derivation: deleting the `kind`
 * field from one row of sink-0023.jsonl moved gatewayHarnessRows 555 -> 554 and
 * gatewayRowsInAClaimedRequest 0 -> 1, and that second number is 0 on every
 * genuine frozen run. It then decided noPostgRESTCall from the label the row no
 * longer carried: rc=0, PASS banner, `noPostgRESTCall 480 satisfied / 0
 * violated`, over a row recording GET /rest/v1/accounts -> 200 inside a claimed
 * request. It computed the truth and consulted the lie.
 *
 * (R8-2) The harness's whole notion of "the data plane" was TWO PATH PREFIXES.
 * sink.mjs classify(), instrument.cjs classifyPath() and observers.mjs
 * classifyGatewayPath() all answered "other" for /storage/v1, /graphql/v1,
 * /realtime/v1 and /functions/v1, no claim read "other" on either observer, and
 * noUnexpectedNetworkCall permits anything addressed to the gateway host. So a
 * storage read, a GraphQL query, a realtime socket and a
 * /functions/v1/place-order invocation each produced 16 of 16 records ALL
 * SATISFIED — measured by driving buildClaims directly, with /rest/v1/accounts
 * and /auth/v1/user as the controls that DO fire. Those are exactly the
 * surfaces the Stage 2 edge exists to deny, and the canary was not watching
 * them. That is a coverage hole, not a forgery: an honest image doing it is
 * recorded honestly by both observers and certifies.
 *
 * THE RULE
 * --------
 * 1. The class is DERIVED from the request path, here, on the host side. No
 *    filter in this file reads a `kind`, a `pathClass` or any other field whose
 *    writer is the thing under test or the row itself.
 * 2. The classification is TOTAL over the Supabase surface — /rest/v1 (and
 *    /rest/v1/rpc/), /auth/v1, /storage/v1, /realtime/v1, /functions/v1,
 *    /graphql/v1, /pg and the Kong root — and every class is named in
 *    GATEWAY_CLASS_READERS below with the claim(s) that read it.
 * 3. AN UNCLASSIFIED DESTINATION IS A REFUSAL, NOT A SILENCE. "unclassified"
 *    is read by noUnexpectedNetworkCall, because a destination the harness
 *    cannot attribute is unattributed, and this programme has already
 *    established that unattributed is not absent.
 * 4. Exactly one class — "harness", the driver's own /__canary control traffic
 *    — is read by no claim, and that exemption is derived from the path too
 *    (observers.mjs), so a data-plane row cannot buy it by calling itself
 *    'harness'.
 * ========================================================================== */

/** Every class classifyGatewayPath can return. Closed, and asserted below to
 *  be exactly the key set of GATEWAY_CLASS_READERS. */
export const GATEWAY_PATH_CLASSES = [
  "auth", "rpc", "postgrest", "graphql", "pg",
  "storage", "realtime", "functions", "kong",
  "harness", "unclassified",
];

/** The one classifier. sink.mjs and instrument.cjs run the same table inside
 *  their own processes so their records are self-consistent, but neither of
 *  those answers is read by a decision: this is. */
export function classifyGatewayPath(p) {
  // NO PATH AT ALL IS NOT THE ROOT PATH. A record with a null/absent/empty
  // destination is a record that does not say where it went; calling that
  // "kong" would give it a name it has not earned. It is unclassified, which
  // is read by noUnexpectedNetworkCall and therefore refuses.
  if (p === null || p === undefined || p === "") return "unclassified";
  const s = String(p);
  if (s.startsWith("/auth/v1")) return "auth";
  if (s.startsWith("/rest/v1/rpc/")) return "rpc";
  if (s.startsWith("/rest/v1")) return "postgrest";
  if (s.startsWith("/graphql/v1")) return "graphql";
  if (s.startsWith("/storage/v1")) return "storage";
  if (s.startsWith("/realtime/v1")) return "realtime";
  if (s.startsWith("/functions/v1")) return "functions";
  if (s === "/pg" || s.startsWith("/pg/")) return "pg";
  if (s.startsWith("/__canary")) return "harness";
  if (s === "/") return "kong";
  return "unclassified";
}

/* WHICH CLAIM READS WHICH CLASS. This table is not documentation beside the
 * decision — it IS the decision: the buckets in buildClaims are built by
 * looking a row's derived class up in here, so a class that is added to the
 * classifier and forgotten here cannot quietly become invisible. It throws at
 * import instead. */
export const GATEWAY_CLASS_READERS = {
  // /auth/v1/* — GoTrue.
  auth:      ["proxyRefusedBeforeAuth", "noAuthCall"],
  // /rest/v1/rpc/* — PostgREST RPC. The three instrumented Vault wrappers are
  // this class plus a name test.
  rpc:       ["noPostgRESTCall", "noDatabaseCall", "noVaultCall"],
  // /rest/v1/* — PostgREST table access.
  postgrest: ["noPostgRESTCall", "noDatabaseCall"],
  // /graphql/v1 — pg_graphql. The resolver runs IN the database, so this is a
  // database call that does not go through PostgREST's table surface.
  graphql:   ["noDatabaseCall"],
  // /pg — pg-meta. A database connection with a different front door.
  pg:        ["noDatabaseCall"],
  // The remaining Supabase surfaces. Each is a network reach the frozen
  // artifact must not make; none is a PostgREST, auth or Vault call, so they
  // are read by the claim that means "this process reached somewhere it had no
  // business reaching" rather than being folded into a narrower claim whose
  // name would then be a lie.
  storage:   ["noUnexpectedNetworkCall"],
  realtime:  ["noUnexpectedNetworkCall"],
  functions: ["noUnexpectedNetworkCall"],
  kong:      ["noUnexpectedNetworkCall"],
  // A destination this harness cannot name. Refused, not ignored.
  unclassified: ["noUnexpectedNetworkCall"],
  // The driver's own control traffic. Read by no claim, on purpose; the
  // exemption is derived from the path in observers.mjs, never read off a row.
  harness:   [],
};

{
  const missing = GATEWAY_PATH_CLASSES.filter((c) => !Object.prototype.hasOwnProperty.call(GATEWAY_CLASS_READERS, c));
  const extra = Object.keys(GATEWAY_CLASS_READERS).filter((c) => !GATEWAY_PATH_CLASSES.includes(c));
  const unknownClaim = Object.entries(GATEWAY_CLASS_READERS)
    .flatMap(([c, cs]) => cs.filter((x) => !REQUIRED_CLAIMS.includes(x)).map((x) => `${c}->${x}`));
  if (missing.length || extra.length || unknownClaim.length) {
    throw new Error(
      "claims.mjs: the gateway path classification and the table of which claim reads which class " +
      "have diverged" +
      (missing.length ? `; classes with no reader entry: ${missing.join(",")}` : "") +
      (extra.length ? `; reader entries for classes the classifier cannot return: ${extra.join(",")}` : "") +
      (unknownClaim.length ? `; reader entries naming a claim that is not in REQUIRED_CLAIMS: ${unknownClaim.join(",")}` : "") +
      ". A class no claim reads is a destination this harness does not watch.");
  }
}

/* EVERY EVENT KIND THAT MEANS "THE PROCESS REACHED OUT", IN ONE PLACE.
 *
 * ROUND-5 AUDIT. This list existed twice in this file — once for `egress`, once
 * for `strayEgress` — and a THIRD, SHORTER copy lived in observers.mjs as
 * `NETWORK_KINDS`, holding four of the eight. observers.mjs used its copy to
 * decide whether a boot-snapshot event was an outbound call, so a `POST
 * https://paper-api.alpaca.markets/v2/orders` recorded as kind
 * `node:https.request` — which instrument.cjs:213-234 emits by construction for
 * every `http`/`https` `request`/`get` — was fully attributed to the boot
 * bucket and refused by nothing. MEASURED: a full certifying PASS, rc=0, with
 * `noBrokerCall: 480 satisfied, 0 violated` and the kind published in
 * `claimEvidence.bootEventKinds` for a reader to not notice.
 *
 * A hand-copied enumeration of what a producer can emit is a defect waiting for
 * the producer to gain a case. This is now the only copy; `HTTP_MODULE_KINDS`
 * below is generated from the same two loops instrument.cjs runs, so adding a
 * module or a function name there is the only edit needed here.
 *
 * `dns.lookup`, `socket.connect` and `tls.connect` are not request-shaped and
 * carry no pathClass, which is why `egress` (the pathClass-filtered set) is a
 * subset of this one rather than equal to it.
 */
const HTTP_MODULE_KINDS = ["node:http", "node:https"]
  .flatMap((m) => ["request", "get"].map((f) => `${m}.${f}`));
/** Request-shaped egress: has a URL, and therefore a pathClass. */
export const REQUEST_EGRESS_KINDS = ["fetch", ...HTTP_MODULE_KINDS];
/** Every outbound-call kind instrument.cjs can emit, request-shaped or not. */
export const EGRESS_KINDS = new Set([
  ...REQUEST_EGRESS_KINDS, "socket.connect", "tls.connect", "dns.lookup",
]);
/** Kinds that cannot exist before a request does: there is no body to read. */
export const REQUEST_ONLY_KINDS = new Set(["body.parse", "body.stream"]);

function rec(claim, status, sensors, detail, reading) {
  return { claim, status, sensors, detail, reading };
}

/**
 * Build the complete claim set for one request.
 *
 * @param obs {{
 *   request: object,            the manifest entry that was driven
 *   response: object|null,      status/headers/body, or null
 *   error: string|null,
 *   events: object[],           instrument events in this request's window
 *   marks: object|null,         V8 marker counts for the window
 *   routeExec: number|null,     route-chunk execution count for the window
 *   sensors: object,            {name: {live: bool, reason?: string}}
 *   sinkEntries: object[],      gateway log entries tagged to this request
 *   canaryHits: object[],       canary events attributed to this request
 *   canaryRows: object[],
 *   policy: {expectStatus: number}
 * }}
 * @returns {object[]} exactly REQUIRED_CLAIMS.length records
 */
export function buildClaims(obs) {
  const S = obs.sensors || {};
  const live = (name) => Boolean(S[name] && S[name].live);
  const why = (names) =>
    names.filter((n) => !live(n))
      .map((n) => `${n}:${(S[n] && S[n].reason) || "absent"}`)
      .join(",");

  const out = [];
  const add = (claim, decide) => {
    const need = CLAIM_SENSORS[claim];
    const dead = need.filter((n) => !live(n));
    if (dead.length) {
      // The whole point: an unavailable observer produces an INDETERMINATE
      // record, which the completeness check treats as a hard failure. It
      // does not produce silence.
      out.push(rec(claim, "indeterminate", need, `sensor unavailable: ${why(need)}`, null));
      return;
    }
    const r = decide();
    out.push(rec(claim, r.ok ? "satisfied" : "violated", need, r.detail, r.reading));
  };

  const ev = obs.events || [];
  const marks = obs.marks || {};
  const sink = obs.sinkEntries || [];
  const status = obs.response ? obs.response.status : null;

  const egress = ev.filter((e) => REQUEST_EGRESS_KINDS.includes(e.kind));
  const hostClass = (e) => (e.detail && e.detail.hostClass) || "unknown";

  /* -- THE GATEWAY'S ROWS, CLASSIFIED BY THIS FILE ------------------------
   * `e.kind` is not read. The class comes from the path, and the bucket a row
   * lands in comes from GATEWAY_CLASS_READERS, so "which claim sees this row"
   * is a table lookup rather than a hand-written filter that can forget a
   * surface. A row whose `kind` disagrees with its path is refused separately,
   * by verdict.mjs, as a record that contradicts itself. */
  const gwClassOf = (e) => {
    const c = classifyGatewayPath(e && e.path);
    // The import-time assertion proves the TABLE covers GATEWAY_PATH_CLASSES.
    // This proves the CLASSIFIER stays inside it. A class the table does not
    // know is a row no claim would read, which is the whole defect, so it is
    // a loud crash (verdict.mjs then writes status NO_VERDICT) rather than a
    // silent fall-through to "nothing sees this".
    if (!Object.prototype.hasOwnProperty.call(GATEWAY_CLASS_READERS, c)) {
      throw new Error(`claims.mjs: classifyGatewayPath returned ${JSON.stringify(c)} for path ` +
        `${JSON.stringify(e && e.path)}, which is not one of ${GATEWAY_PATH_CLASSES.join(",")}; ` +
        "no claim reads it and this run cannot say anything about that row");
    }
    return c;
  };
  const gwRowsFor = (claim) =>
    sink.filter((e) => GATEWAY_CLASS_READERS[gwClassOf(e)].includes(claim));
  const gatewayClassCounts = {};
  for (const c of GATEWAY_PATH_CLASSES) gatewayClassCounts[c] = 0;
  for (const e of sink) gatewayClassCounts[gwClassOf(e)]++;
  const nameClasses = (rows) =>
    [...new Set(rows.map((e) => `${gwClassOf(e)}:${String((e && e.path) || "")}`))].join(",");

  /* -- THE IMAGE'S OWN EGRESS, CLASSIFIED THE SAME WAY --------------------
   * `detail.pathClass` is computed inside the process under test. It is still
   * written, still attested and still cross-checked (verdict.mjs refuses a
   * record whose declared class contradicts its own URL), but no decision here
   * reads it: the path sitting beside it in the same record is classified by
   * the function above. Before round 8 an /storage/v1 or /functions/v1 fetch
   * carried pathClass "other" and matched no filter at all. */
  const eventPath = (e) => {
    const d = (e && e.detail) || {};
    if (typeof d.pathname === "string" && d.pathname !== "") return d.pathname;
    if (typeof d.path === "string" && d.path !== "") return d.path;
    if (typeof d.url === "string" && d.url !== "") {
      try { return new URL(d.url).pathname; } catch { /* relative or unparseable */ }
    }
    return null;
  };
  /** null when the record carries no readable destination path at all. */
  const evClassOf = (e) => {
    const p = eventPath(e);
    return p === null ? null : classifyGatewayPath(p);
  };
  const namesTheGateway = (e) => {
    const d = (e && e.detail) || {};
    if (d.hostClass === "supabase-sink") return true;
    return ["host", "hostname", "url", "servername", "origin", "authority"]
      .some((k) => typeof d[k] === "string" && d[k].includes(HARNESS_SINK_HOST));
  };

  /* The image-side buckets come out of the SAME table as the gateway-side ones,
   * so a class added to the classifier reaches both observers or neither. A
   * hand-written list here would be the drift GATEWAY_CLASS_READERS exists to
   * prevent, one observer along. */
  const classesRead = (claim) =>
    GATEWAY_PATH_CLASSES.filter((c) => GATEWAY_CLASS_READERS[c].includes(claim));
  const AUTH_CLASSES = classesRead("noAuthCall");
  const REST_CLASSES = classesRead("noPostgRESTCall");
  const SURFACE_CLASSES = classesRead("noUnexpectedNetworkCall");

  const instrAuth = egress.filter((e) => AUTH_CLASSES.includes(evClassOf(e)));
  const instrRest = egress.filter((e) => REST_CLASSES.includes(evClassOf(e)));
  /* The surface classes are scoped to egress ADDRESSED TO THE GATEWAY. A
   * loopback path that happens to look like one of them is the app calling
   * itself, and a non-gateway host is already stray by hostClass. */
  const instrOtherSurface = egress.filter((e) =>
    namesTheGateway(e) && SURFACE_CLASSES.includes(evClassOf(e)));

  const sinkAuth = gwRowsFor("noAuthCall");
  const sinkRest = gwRowsFor("noPostgRESTCall");
  const sinkDb = gwRowsFor("noDatabaseCall");
  const sinkNet = gwRowsFor("noUnexpectedNetworkCall");
  const sinkVault = gwRowsFor("noVaultCall")
    .filter((e) => /vault_(create|update|delete)_secret/.test(e.path || ""));
  const bodyReads = ev.filter((e) => REQUEST_ONLY_KINDS.has(e.kind));
  const envReads = ev.filter((e) => e.kind === "env.read" &&
    ["SUPABASE_SERVER_URL", "SUPABASE_SERVICE_ROLE_KEY"].includes(e.detail && e.detail.name));
  const brokerEvents = ev.filter((e) => hostClass(e) === "broker" ||
    (e.kind === "dns.lookup" && hostClass(e) === "broker"));
  const pgSockets = ev.filter((e) => e.kind === "socket.connect" && e.detail && e.detail.port === 5432);
  const strayEgress = ev.filter((e) =>
    EGRESS_KINDS.has(e.kind) && !ALLOWED_HOST_CLASSES.has(hostClass(e)));

  // Only markers on code that RUNS when a client is constructed decide the
  // claim; the throw-branch and module-level markers are recorded and never
  // decisive (see the MARKER CHOICE note in instrument.cjs).
  const supabaseMarks = ["app_service_key_read", "app_server_url_read",
    "supabase_client_options", "ssr_cookie_decode"].filter((k) => (marks[k] || 0) > 0);
  const brokerMarks = ["broker_request_headers", "broker_unreachable"]
    .filter((k) => (marks[k] || 0) > 0);

  add("requestDriven", () => ({
    ok: Boolean(obs.request && (obs.response || obs.error)),
    detail: obs.error ? `transport error: ${obs.error}` : "request issued and a response was recorded",
    reading: { id: obs.request && obs.request.id },
  }));

  add("routeMatched", () => ({
    ok: status !== null && status !== 404,
    detail: status === 404
      ? "the endpoint under test returned 404; the matrix would be driving nothing"
      : `status ${status}`,
    reading: { status },
  }));

  add("expectedResponseClass", () => ({
    ok: status === obs.policy.expectStatus,
    detail: `expected ${obs.policy.expectStatus}, got ${status === null ? "no response" : status}`,
    reading: { status, expected: obs.policy.expectStatus },
  }));

  /* A REFUSAL MUST BE THE RIGHT REFUSAL (audit finding B6).
   *
   * `expectedResponseClass` and `proxyRefusedBeforeAuth` asserted `status ===
   * 503` and nothing else, while the driver was already recording
   * `x-artifact-role`, `x-writes-enabled` and 600 bytes of body and none of it
   * was read. The frozen proxy has its OWN 503 branch — "Authentication
   * service temporarily unavailable", also `Cache-Control: no-store` — which
   * satisfied the old claim identically to the freeze refusal. So did any
   * upstream 503. The lesson is A3's, one level along: a control that accepts
   * "it failed" instead of "it failed for this reason" is a control that
   * cannot distinguish the thing it exists to detect.
   *
   * The identity is COMMITTED in the request manifest rather than written here,
   * so changing what counts as the freeze refusal is a visible edit to an
   * expectation file. */
  add("refusalIdentity", () => {
    const want = (obs.policy && obs.policy.refusalIdentity) || null;
    if (!want || Object.keys(want).length === 0) {
      return {
        ok: false,
        detail: "the manifest pins no refusal identity, so a 503 for any reason would satisfy this claim",
        reading: { pinned: null },
      };
    }
    const h = (obs.response && obs.response.headers) || {};
    let body = null;
    try { body = JSON.parse((obs.response && obs.response.body) || ""); } catch { body = null; }
    const got = {};
    const diffs = [];
    for (const [key, expected] of Object.entries(want)) {
      let actual;
      if (key.startsWith("header:")) {
        const name = key.slice("header:".length).toLowerCase();
        actual = Object.prototype.hasOwnProperty.call(h, name) ? h[name] : null;
      } else if (key.startsWith("body.")) {
        const field = key.slice("body.".length);
        actual = body && Object.prototype.hasOwnProperty.call(body, field) ? body[field] : null;
      } else {
        diffs.push(`${key}: unsupported selector in the manifest`);
        continue;
      }
      got[key] = actual;
      if (String(actual) !== String(expected)) {
        diffs.push(`${key}=${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
      }
    }
    return {
      ok: diffs.length === 0,
      detail: diffs.length
        ? `not the frozen refusal: ${diffs.join("; ")}`
        : "the refusal carries the frozen artifact's own identity",
      reading: { got, want },
    };
  });

  add("responseStatus", () => ({
    ok: typeof status === "number",
    detail: typeof status === "number" ? `status ${status}` : "no response was received",
    reading: { status },
  }));

  add("proxyRefusedBeforeAuth", () => {
    const authSeen = instrAuth.length + sinkAuth.length;
    return {
      ok: authSeen === 0 && status === obs.policy.expectStatus,
      detail: authSeen
        ? `${authSeen} authentication calls happened before the refusal`
        : `refused with ${status} and no authentication call was made`,
      reading: { instrAuth: instrAuth.length, sinkAuth: sinkAuth.length, status },
    };
  });

  add("handlerNotReached", () => ({
    ok: (obs.routeExec || 0) === 0,
    detail: (obs.routeExec || 0) === 0
      ? "no route-handler chunk executed in this request's window"
      : `route-handler chunks executed ${obs.routeExec} times`,
    reading: { routeExec: obs.routeExec || 0 },
  }));

  add("noAuthCall", () => ({
    ok: instrAuth.length === 0 && sinkAuth.length === 0,
    detail: `instrument=${instrAuth.length} gateway=${sinkAuth.length}`,
    reading: { instrAuth: instrAuth.length, sinkAuth: sinkAuth.length },
  }));

  add("noBodyParse", () => ({
    ok: bodyReads.length === 0,
    detail: bodyReads.length
      ? `body read via ${bodyReads.map((e) => (e.detail && e.detail.method) || "body").join(",")}`
      : "no Request body accessor was called",
    reading: { count: bodyReads.length },
  }));

  add("noSupabaseClient", () => ({
    ok: supabaseMarks.length === 0 && envReads.length === 0,
    detail: `marks=${supabaseMarks.join("+") || "-"} env=${envReads.map((e) => e.detail.name).join("+") || "-"}`,
    reading: { marks: supabaseMarks, env: envReads.length },
  }));

  add("noPostgRESTCall", () => ({
    ok: instrRest.length === 0 && sinkRest.length === 0,
    detail: sinkRest.length
      ? `instrument=${instrRest.length} gateway=${sinkRest.length} (${nameClasses(sinkRest)})`
      : `instrument=${instrRest.length} gateway=0`,
    reading: { instrRest: instrRest.length, sinkRest: sinkRest.length },
  }));

  /* `sinkDb` is every gateway class GATEWAY_CLASS_READERS names for this claim:
   * postgrest and rpc as before, plus graphql (pg_graphql resolves inside the
   * database) and pg (pg-meta is a database connection with another front
   * door). Before round 8 the last two classified as "other" and were read by
   * nothing. */
  add("noDatabaseCall", () => ({
    ok: sinkDb.length === 0 && pgSockets.length === 0,
    detail: sinkDb.length
      ? `viaGateway=${sinkDb.length} (${nameClasses(sinkDb)}) directSockets=${pgSockets.length}`
      : `viaGateway=0 directSockets=${pgSockets.length}`,
    reading: { sinkRest: sinkRest.length, sinkDb: sinkDb.length, pgSockets: pgSockets.length },
  }));

  add("noVaultCall", () => {
    const hits = (obs.canaryHits || []).length;
    const rows = (obs.canaryRows || []).length;
    return {
      ok: hits === 0 && rows === 0 && sinkVault.length === 0,
      detail: `canaryLog=${hits} canaryRows=${rows} gatewayRpc=${sinkVault.length}`,
      reading: { hits, rows, gatewayRpc: sinkVault.length },
    };
  });

  add("noBrokerCall", () => ({
    ok: brokerEvents.length === 0 && brokerMarks.length === 0,
    detail: `events=${brokerEvents.length} marks=${brokerMarks.join("+") || "-"}`,
    reading: { events: brokerEvents.length, marks: brokerMarks },
  }));

  /* TWO QUESTIONS, NOT ONE. "Did the process reach a host it should not have"
   * (strayEgress, by host class) was the whole claim until round 8, and it let
   * every Supabase surface except /auth/v1 and /rest/v1 through, because those
   * are addressed to the gateway host and the gateway host is allowed. The
   * second question is "and was every gateway request to a surface some claim
   * reads": storage, realtime, functions and the Kong root are Supabase
   * surfaces no narrower claim covers, and `unclassified` is a destination this
   * harness cannot name at all. An unattributed destination is not an absent
   * one, so it is a violation here rather than a silence. */
  add("noUnexpectedNetworkCall", () => {
    const bits = [];
    if (strayEgress.length) {
      bits.push(`to ${[...new Set(strayEgress.map((e) => `${hostClass(e)}:${(e.detail && (e.detail.host || e.detail.hostname)) || "?"}`))].join(",")}`);
    }
    if (sinkNet.length) bits.push(`gatewaySurface=${nameClasses(sinkNet)}`);
    if (instrOtherSurface.length) {
      bits.push(`imageEgressToGatewaySurface=${[...new Set(instrOtherSurface.map((e) => `${evClassOf(e)}:${eventPath(e)}`))].join(",")}`);
    }
    return {
      ok: strayEgress.length === 0 && sinkNet.length === 0 && instrOtherSurface.length === 0,
      detail: bits.length
        ? bits.join(" ")
        : "every egress attempt was to the recording gateway or loopback, and every gateway " +
          "request was to a Supabase surface some claim reads",
      reading: {
        count: strayEgress.length,
        gatewaySurface: sinkNet.length,
        gatewayUnclassified: sinkNet.filter((e) => gwClassOf(e) === "unclassified").length,
        imageEgressToGatewaySurface: instrOtherSurface.length,
        gatewayRowsByClass: gatewayClassCounts,
      },
    };
  });

  add("canaryObservationComplete", () => {
    const attributable = Boolean(obs.canaryAttributable);
    return {
      ok: attributable,
      detail: attributable
        ? "the canary reading covers this request's window and the sensor runner reported it trustworthy"
        : "the canary reading cannot be attributed to this request",
      reading: { attributable },
    };
  });

  return out;
}

/* --------------------------------------------------------------------------
 * Completeness. Evaluated before any verdict; a failure here is not a finding
 * about the image, it is a statement that this run cannot say anything.
 * ------------------------------------------------------------------------ */

export function checkCompleteness(records, context) {
  const problems = [];
  const seen = new Map();
  for (const r of records) {
    if (!r || typeof r !== "object") {
      problems.push(`${context}: a claim record is not an object`);
      continue;
    }
    if (typeof r.claim !== "string" || !REQUIRED_CLAIMS.includes(r.claim)) {
      problems.push(`${context}: unknown claim ${JSON.stringify(r.claim)}`);
      continue;
    }
    if (!CLAIM_STATUSES.includes(r.status)) {
      problems.push(`${context}/${r.claim}: malformed status ${JSON.stringify(r.status)}`);
    }
    if (!Array.isArray(r.sensors) || r.sensors.length === 0) {
      problems.push(`${context}/${r.claim}: no sensors named`);
    } else {
      for (const s of r.sensors) {
        if (!ALL_SENSORS.includes(s)) problems.push(`${context}/${r.claim}: unknown sensor ${s}`);
      }
    }
    seen.set(r.claim, (seen.get(r.claim) || 0) + 1);
  }
  for (const c of REQUIRED_CLAIMS) {
    const n = seen.get(c) || 0;
    if (n === 0) problems.push(`${context}: MISSING claim ${c}`);
    else if (n > 1) problems.push(`${context}: DUPLICATE claim ${c} (${n} records)`);
  }
  return problems;
}

export function summarise(records) {
  const out = { satisfied: 0, violated: 0, indeterminate: 0, violatedClaims: [], indeterminateClaims: [] };
  for (const r of records) {
    if (r.status === "satisfied") out.satisfied++;
    else if (r.status === "violated") { out.violated++; out.violatedClaims.push(r.claim); }
    else { out.indeterminate++; out.indeterminateClaims.push(r.claim); }
  }
  return out;
}
