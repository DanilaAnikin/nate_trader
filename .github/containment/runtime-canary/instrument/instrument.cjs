/* ==========================================================================
 * instrument.cjs — the in-process half of the runtime canary
 *
 * Loaded into the dashboard image under test with
 * `NODE_OPTIONS=--require /canary/instrument.cjs`, i.e. before Next's server
 * starts. The image itself is NOT modified: the same digest runs frozen and
 * instrumented, which is the only way the run says anything about the artifact
 * that would be deployed.
 *
 * WHAT IT WATCHES, AND WHY EACH SENSOR IS HERE RATHER THAN JUST ONE
 * -----------------------------------------------------------------
 * The claims to be falsified are: zero Auth calls, zero request-body parsing,
 * zero Supabase client construction, zero PostgREST/RPC calls, zero DB calls,
 * no broker call. Each has a different best observer, and several have a
 * second one because the first has a known blind spot.
 *
 *  1. EGRESS.  `fetch`, `http/https.request`, `net.Socket#connect`,
 *     `tls.connect`, `dns.lookup`. Every Auth call, PostgREST call, RPC and
 *     broker call is one of these, whichever client library makes it — a
 *     `pg` connection that bypassed PostgREST would still be a socket. DNS is
 *     watched separately because on the harness's `--internal` network a
 *     broker call FAILS at name resolution, and a sensor that only saw
 *     completed connections would score that attempt as "no broker call".
 *
 *  2. BODY PARSING.  `Request.prototype.{json,text,arrayBuffer,formData,blob,
 *     bytes}` and the `body` getter. A route handler's `req.json()` resolves
 *     through this prototype (NextRequest extends the global Request and does
 *     not override them).
 *
 *  3. SUPABASE CLIENT CONSTRUCTION.  Two sensors, because the obvious one is
 *     not available: `next build` BUNDLES `@supabase/*` into the server chunks
 *     (verified: the runner image has no `node_modules/@supabase`), so a
 *     require-hook can never fire. Instead:
 *       (a) a `process.env` proxy, because every client this app constructs
 *           goes through `getSupabaseServerUrl()` reading `SUPABASE_SERVER_URL`
 *           and the service client additionally reads
 *           `SUPABASE_SERVICE_ROLE_KEY`; and
 *       (b) V8 PRECISE COVERAGE against string-literal markers — "did the byte
 *           range containing `supabaseUrl is required` execute?" That question
 *           survives bundling and minification, because the literal survives
 *           both, and it is answered from the running V8 heap rather than from
 *           anything the app cooperates with.
 *     Neither is trusted until the mutant makes it fire (see run.sh's
 *     property-B controls). A sensor that has never been seen to fire is not a
 *     sensor.
 *
 * The instrument NEVER records a header value, a cookie value or an env value:
 * only names, lengths and digests.
 * ========================================================================== */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const OUT_DIR = process.env.NT_CANARY_INSTR_OUT || "/instr";
const EVENTS = path.join(OUT_DIR, "events.jsonl");
const CTL_PORT = Number(process.env.NT_CANARY_CTL_PORT || 3999);
const BROKER_HOSTS = (process.env.NT_CANARY_BROKER_HOSTS ||
  "paper-api.alpaca.markets,api.alpaca.markets,data.alpaca.markets")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SINK_HOST = process.env.NT_CANARY_SINK_HOST || "nt-canary-sink";

let seq = 0;
const memory = [];

try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* already there */ }

function shortStack(skip) {
  const e = {};
  Error.captureStackTrace(e, skip);
  return String(e.stack || "")
    .split("\n").slice(1, 7)
    .map((l) => l.trim().replace(/^at /, ""))
    .filter(Boolean);
}

function emitWithStack(kind, detail, stack) {
  const ev = { seq: ++seq, t: Date.now(), kind, detail, stack };
  memory.push(ev);
  try { fs.appendFileSync(EVENTS, JSON.stringify(ev) + "\n"); } catch { /* best effort */ }
  return ev;
}

function emit(kind, detail, skip) {
  return emitWithStack(kind, detail, shortStack(skip || emit));
}

/**
 * True when the immediate caller is this file.
 *
 * The control endpoints below read the same environment variables the sensors
 * watch, so without this the instrument records ITS OWN reads and attributes
 * them to whichever request happened to be in flight — which showed up as a
 * "Supabase client constructed" finding against an image that had done nothing
 * at all. A sensor must not be able to trip itself.
 */
function selfOriginated(stack) {
  return String(stack[0] || "").includes("/canary/instrument.cjs");
}

/** Never a value: a name, a length, and a short digest so two values can be
 *  compared without either being printed. */
function fingerprint(v) {
  if (v === undefined || v === null) return { present: false };
  const s = String(v);
  return {
    present: true,
    length: s.length,
    sha256_8: crypto.createHash("sha256").update(s).digest("hex").slice(0, 8),
  };
}

function classifyHost(host) {
  if (!host) return "unknown";
  const h = String(host).toLowerCase();
  if (BROKER_HOSTS.some((b) => h === b || h.endsWith("." + b))) return "broker";
  if (h === SINK_HOST.toLowerCase()) return "supabase-sink";
  if (h === "127.0.0.1" || h === "localhost" || h === "::1") return "loopback";
  return "other";
}

/* SELF-REPORTED, AND NOTHING IS DECIDED FROM IT (round-8 audit).
 *
 * This runs inside the process under test, so the host side re-derives the
 * class from the `pathname`/`path`/`url` written beside it in the same record
 * (driver/claims.mjs classifyGatewayPath) and refuses a record whose declared
 * class contradicts its own URL. The table is kept identical to the host-side
 * one for exactly that comparison.
 *
 * It used to answer "other" to /storage/v1, /realtime/v1, /functions/v1,
 * /graphql/v1 and /pg, and no claim read "other" on either observer, so the
 * whole Supabase surface outside /auth/v1 and /rest/v1 was unwatched. */
function classifyPath(p) {
  // A record with no readable destination path at all — `http.request({...})`
  // with no `path` — is "unclassified", not the Kong root. The host side
  // derives nothing from such a record and therefore compares nothing.
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

/* -- 1. egress ------------------------------------------------------------ */

const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = function instrumentedFetch(input, init) {
    let url = "";
    let method = (init && init.method) || "GET";
    try {
      if (typeof input === "string") url = input;
      else if (input && typeof input.url === "string") { url = input.url; method = input.method || method; }
      else url = String(input);
    } catch { url = "(unreadable)"; }
    let host = "", pathname = "";
    try { const u = new URL(url); host = u.host; pathname = u.pathname; } catch { /* relative */ }
    emit("fetch", {
      method, url, host, pathname,
      hostClass: classifyHost(host.split(":")[0]),
      pathClass: classifyPath(pathname),
    }, instrumentedFetch);
    return realFetch.call(this, input, init);
  };
}

const net = require("node:net");
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function instrumentedConnect(...args) {
  let host, port, socketPath;
  // `net.connect(options)` does NOT reach here as `connect(options)`. It runs
  // `normalizeArgs` first and calls `socket.connect([options, callback])` —
  // an ARRAY. Reading `.host`/`.port` off the array yields undefined, which is
  // how a deliberate connection to postgres:5432 was recorded as
  // `host=null port=null hostClass=unknown` and the `noDatabaseCall` claim
  // came back satisfied. The positive mutant for that claim is what found it.
  let a0 = args[0];
  if (Array.isArray(a0)) a0 = a0[0];
  if (a0 && typeof a0 === "object") {
    host = a0.host || a0.hostname;
    port = a0.port;
    socketPath = a0.path;
  } else if (typeof a0 === "number" || (typeof a0 === "string" && /^\d+$/.test(a0))) {
    port = Number(a0);
    host = typeof args[1] === "string" ? args[1] : undefined;
  } else if (typeof a0 === "string") {
    socketPath = a0;
  }
  emit("socket.connect", {
    host: host || null,
    port: port === undefined || port === null ? null : Number(port),
    socketPath: socketPath || null,
    hostClass: classifyHost(host),
  }, instrumentedConnect);
  return realConnect.apply(this, args);
};

const tls = require("node:tls");
const realTlsConnect = tls.connect;
tls.connect = function instrumentedTlsConnect(...args) {
  const a0 = args[0];
  const host = a0 && typeof a0 === "object" ? (a0.host || a0.servername) : undefined;
  emit("tls.connect", { host: host || null, hostClass: classifyHost(host) }, instrumentedTlsConnect);
  return realTlsConnect.apply(this, args);
};

const dns = require("node:dns");
function wrapLookup(obj, key, label) {
  const real = obj[key];
  if (typeof real !== "function") return;
  obj[key] = function instrumentedLookup(hostname, ...rest) {
    // `server.listen("0.0.0.0")` resolves a BIND address, not a destination.
    // Recording it would put a permanent event in every request window.
    if (hostname !== "0.0.0.0" && hostname !== "::" && hostname !== "") {
      emit("dns.lookup", { hostname, hostClass: classifyHost(hostname), via: label }, instrumentedLookup);
    }
    return real.call(this, hostname, ...rest);
  };
}
wrapLookup(dns, "lookup", "dns.lookup");
if (dns.promises) wrapLookup(dns.promises, "lookup", "dns.promises.lookup");

for (const modName of ["node:http", "node:https"]) {
  const mod = require(modName);
  for (const fn of ["request", "get"]) {
    const real = mod[fn];
    if (typeof real !== "function") continue;
    mod[fn] = function instrumentedHttp(...args) {
      let host = null, p = null, method = null;
      const a0 = args[0];
      try {
        if (typeof a0 === "string") { const u = new URL(a0); host = u.host; p = u.pathname; }
        else if (a0 instanceof URL) { host = a0.host; p = a0.pathname; }
        else if (a0 && typeof a0 === "object") { host = a0.host || a0.hostname; p = a0.path; method = a0.method; }
      } catch { /* unparseable */ }
      emit(`${modName}.${fn}`, {
        host, path: p, method,
        hostClass: classifyHost(String(host || "").split(":")[0]),
        pathClass: classifyPath(p),
      }, instrumentedHttp);
      return real.apply(this, args);
    };
  }
}

/* -- 2. request-body parsing ---------------------------------------------- */

if (globalThis.Request && globalThis.Request.prototype) {
  const proto = globalThis.Request.prototype;
  for (const m of ["json", "text", "arrayBuffer", "formData", "blob", "bytes"]) {
    const real = proto[m];
    if (typeof real !== "function") continue;
    Object.defineProperty(proto, m, {
      configurable: true,
      writable: true,
      value: function instrumentedBodyRead(...args) {
        let url = "";
        try { url = this.url; } catch { /* detached */ }
        emit("body.parse", { method: m, requestUrl: url }, instrumentedBodyRead);
        return real.apply(this, args);
      },
    });
  }
  const bodyDesc = Object.getOwnPropertyDescriptor(proto, "body");
  if (bodyDesc && typeof bodyDesc.get === "function") {
    const realGet = bodyDesc.get;
    Object.defineProperty(proto, "body", {
      configurable: true,
      enumerable: bodyDesc.enumerable,
      get: function instrumentedBodyGet() {
        let url = "";
        try { url = this.url; } catch { /* detached */ }
        emit("body.stream", { requestUrl: url }, instrumentedBodyGet);
        return realGet.call(this);
      },
    });
  }
}

/* -- 3a. env reads --------------------------------------------------------- */

const WATCHED_ENV = new Set([
  "SUPABASE_SERVER_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "DASHBOARD_MAINTENANCE_MODE",
  "DASHBOARD_SIDECAR_ONLY",
  "DASHBOARD_FREEZE_BYPASS_USERS",
]);

try {
  const realEnv = process.env;
  const envGetTrap = function envGetTrap(target, prop) {
    if (typeof prop === "string" && WATCHED_ENV.has(prop)) {
      const st = shortStack(envGetTrap);
      if (!selfOriginated(st)) {
        emitWithStack("env.read", { name: prop, value: fingerprint(target[prop]) }, st);
      }
    }
    // Deliberately NOT Reflect.get(target, prop, receiver): with the proxy as
    // receiver the getter would re-enter and Node's env object rejects the
    // synthesised descriptor.
    return target[prop];
  };
  process.env = new Proxy(realEnv, {
    get: envGetTrap,
    // `process.env` is a host object that only accepts plain assignment. The
    // default [[Set]] path goes through [[DefineOwnProperty]] with a partial
    // descriptor, which it refuses with ERR_INVALID_OBJECT_DEFINE_PROPERTY —
    // and Next's own `server.js` sets NODE_ENV on line 5, so without these
    // traps the image under test does not boot at all. Observed, then fixed.
    set(target, prop, value) { target[prop] = value; return true; },
    defineProperty(target, prop, desc) {
      if (Object.prototype.hasOwnProperty.call(desc, "value")) target[prop] = desc.value;
      return true;
    },
    deleteProperty(target, prop) { delete target[prop]; return true; },
    getOwnPropertyDescriptor(target, prop) {
      const v = target[prop];
      return v === undefined
        ? undefined
        : { value: v, writable: true, enumerable: true, configurable: true };
    },
  });
  // Prove the proxy did not break assignment before the app depends on it.
  process.env.NT_CANARY_ENV_PROXY_SELFTEST = "ok";
  if (process.env.NT_CANARY_ENV_PROXY_SELFTEST !== "ok") {
    throw new Error("the process.env proxy does not round-trip an assignment");
  }
  delete process.env.NT_CANARY_ENV_PROXY_SELFTEST;
} catch (e) {
  emit("instrument.error", { where: "process.env proxy", message: String(e && e.message) });
}

/* -- 3b. V8 precise coverage, against string-literal markers --------------- */
/*
 * The rigorous construction sensor. Node is asked for per-function execution
 * counts; a marker is "executed" when the innermost covered range containing
 * the marker's byte offset has a non-zero count. Because the question is asked
 * about a byte offset in the shipped file, it does not matter that webpack
 * bundled the module or that SWC renamed every identifier around the literal.
 */
/*
 * MARKER CHOICE IS THE WHOLE SENSOR.
 *
 * V8 gives BLOCK coverage: the innermost range containing an offset carries
 * that block's count. So a marker must sit on code that runs when the thing
 * happens — not in the branch that runs when it goes wrong. The first version
 * of this list used `"SUPABASE_SERVICE_ROLE_KEY is not set"` and
 * `"supabaseUrl is required"`, which live inside `throw` branches that are
 * never taken when the key IS set: the mutant constructed clients all day and
 * the sensor read zero. Those two are kept, clearly labelled, because a
 * throw-branch marker firing is still information; nothing decides a claim on
 * them.
 *
 * Likewise `paper-api.alpaca.markets` is a module-level object literal
 * evaluated at import, so it fires once when the module loads and never again.
 * The broker claim reads `APCA-API-KEY-ID` instead — a header built inside
 * `validateAlpacaKeys`, at call time — and the DNS/socket sensors above.
 */
const MARKERS = [
  // executed first lines of this app's Supabase factories
  { id: "app_service_key_read", literal: "env.SUPABASE_SERVICE_ROLE_KEY" },
  { id: "app_server_url_read", literal: "env.SUPABASE_SERVER_URL" },
  // the options object every client construction here evaluates
  { id: "supabase_client_options", literal: "persistSession" },
  // @supabase/ssr decoding a session cookie
  { id: "ssr_cookie_decode", literal: "base64-" },
  // auth-js actually looked for a session
  { id: "auth_session_missing", literal: "Auth session missing" },
  // built inside validateAlpacaKeys, at call time
  { id: "broker_request_headers", literal: "APCA-API-KEY-ID" },
  { id: "broker_unreachable", literal: "Could not reach Alpaca" },
  // the tombstoned wrapper names, inside the credentials helper
  { id: "vault_create_secret_literal", literal: "vault_create_secret" },
  { id: "vault_update_secret_literal", literal: "vault_update_secret" },
  { id: "vault_delete_secret_literal", literal: "vault_delete_secret" },
  // throw-branch and module-level markers: reported, never decisive
  { id: "throwbranch_supabase_url_required", literal: "supabaseUrl is required" },
  { id: "modulelevel_broker_base_url", literal: "paper-api.alpaca.markets" },
];

const coverage = { enabled: false, error: null, sites: [], session: null, routeScripts: [] };

/**
 * Route-handler execution, as a first-class sensor.
 *
 * `handlerNotReached` is one of the claims the matrix makes, and until now it
 * had no observer at all: the harness inferred it from the response code. In
 * the frozen artifact the proxy refuses a mutating method at the edge, so the
 * route module is never even loaded — and "never loaded" is directly visible
 * in V8's coverage report, because a script that was never compiled does not
 * appear in it and one that ran has a non-zero count somewhere.
 *
 * This is deliberately per-SCRIPT rather than per-literal: it needs no marker
 * inside the handler, so it cannot be defeated by a refactor that moves the
 * string, and it covers every route chunk including ones added later.
 */
function indexRouteChunks(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile() && e.name === "route.js") out.push(full);
    }
  }
  return out;
}

function indexMarkers(root) {
  const sites = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile() || !full.endsWith(".js")) continue;
      let src;
      try { src = fs.readFileSync(full, "utf8"); } catch { continue; }
      for (const m of MARKERS) {
        let from = 0;
        for (;;) {
          const at = src.indexOf(m.literal, from);
          if (at < 0) break;
          sites.push({ id: m.id, file: full, offset: at });
          from = at + m.literal.length;
        }
      }
    }
  }
  return sites;
}

try {
  const inspector = require("node:inspector");
  const session = new inspector.Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  coverage.session = session;
  coverage.sites = indexMarkers("/app/.next/server");
  coverage.routeScripts = indexRouteChunks("/app/.next/server/app/api");
  coverage.enabled = true;
  emit("instrument.coverage", {
    indexed: coverage.sites.length,
    routeChunks: coverage.routeScripts.length,
    byMarker: MARKERS.map((m) => ({ id: m.id, sites: coverage.sites.filter((s) => s.id === m.id).length })),
  });
} catch (e) {
  coverage.error = String((e && e.message) || e);
  emit("instrument.error", { where: "coverage", message: coverage.error });
}

function readMarks() {
  if (!coverage.enabled) return { error: coverage.error || "coverage not enabled" };
  return new Promise((resolve) => {
    coverage.session.post("Profiler.takePreciseCoverage", (err, res) => {
      if (err) return resolve({ error: String(err.message || err) });
      const byFile = new Map();
      for (const script of res.result || []) {
        let file = script.url || "";
        if (file.startsWith("file://")) file = file.slice("file://".length);
        if (!file.startsWith("/app/")) continue;
        byFile.set(file, script.functions || []);
      }
      const out = {};
      for (const m of MARKERS) out[m.id] = 0;
      for (const site of coverage.sites) {
        const fns = byFile.get(site.file);
        if (!fns) continue;
        // Innermost covering range wins: outer ranges keep the count of the
        // enclosing function, which would report a never-taken branch as run.
        let best = null;
        for (const fn of fns) {
          for (const r of fn.ranges || []) {
            if (r.startOffset <= site.offset && site.offset < r.endOffset) {
              if (!best || r.endOffset - r.startOffset < best.endOffset - best.startOffset) best = r;
            }
          }
        }
        if (best && best.count > 0) out[site.id] += best.count;
      }
      // Route-chunk execution over the same window. A route module that was
      // never reached is either absent from the report or carries only zero
      // counts; either way this sums to 0.
      const routeExec = {};
      let routeTotal = 0;
      for (const script of coverage.routeScripts) {
        const fns = byFile.get(script);
        let n = 0;
        if (fns) for (const fn of fns) for (const r of fn.ranges || []) n += r.count;
        if (n > 0) routeExec[script] = n;
        routeTotal += n;
      }
      // NOTE: `Profiler.takePreciseCoverage` RESETS the counters, so `out` is
      // already the reading for the window since the previous call — the
      // caller must not subtract a previous reading from it.
      resolve({
        marks: out,
        scripts: byFile.size,
        sites: coverage.sites.length,
        routeChunksIndexed: coverage.routeScripts.length,
        routeExec,
        routeTotal,
        windowed: true,
      });
    });
  });
}

/* -- the control surface --------------------------------------------------- */
/*
 * Reachable only from inside the harness's `--internal` docker network, which
 * has no route to anything else. It exposes readings, never controls: there is
 * no endpoint here that can change what the image does.
 */
const ctl = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://ctl");
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/ping") return json(200, { ok: true, pid: process.pid, events: seq });
    if (url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") || 0);
      return json(200, { seq, events: memory.filter((e) => e.seq > since) });
    }
    if (url.pathname === "/marks") return json(200, await readMarks());
    if (url.pathname === "/env") {
      // Names and presence only, so a run's configuration can be recorded
      // without the report carrying a single value.
      const names = [...WATCHED_ENV].sort();
      return json(200, {
        env: Object.fromEntries(names.map((n) => [n, fingerprint(process.env[n])])),
        raw_freeze_flags: {
          DASHBOARD_MAINTENANCE_MODE: process.env.DASHBOARD_MAINTENANCE_MODE ?? null,
          DASHBOARD_SIDECAR_ONLY: process.env.DASHBOARD_SIDECAR_ONLY ?? null,
          DASHBOARD_FREEZE_BYPASS_USERS: process.env.DASHBOARD_FREEZE_BYPASS_USERS ?? null,
        },
      });
    }
    return json(404, { error: "no such control endpoint" });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
});
ctl.listen(CTL_PORT, "0.0.0.0", () => emit("instrument.ready", { ctlPort: CTL_PORT }));
ctl.unref();

emit("instrument.loaded", {
  node: process.version,
  brokerHosts: BROKER_HOSTS,
  sinkHost: SINK_HOST,
});
