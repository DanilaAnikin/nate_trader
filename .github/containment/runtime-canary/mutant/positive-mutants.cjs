/* ==========================================================================
 * positive-mutants.cjs — make each claim's detector fire, on purpose
 *
 * WHY THESE EXIST
 * ---------------
 * Every interesting claim in this matrix is an ABSENCE: no body was parsed, no
 * Supabase client was built, no broker was called. An absence reported by a
 * detector that has never been seen to fire is worth nothing, and the harness
 * has already been burned by exactly that — three claims silently ceased to
 * exist when the in-process instrument was missing from a container, and the
 * row printed clean for a request that had provably done both of the things
 * the claims denied.
 *
 * So for each claim there is a mutant that DOES the forbidden thing, in the
 * real image, in the real request window, and the corresponding claim must
 * come back `violated`. A claim whose mutant does not trip it is a claim that
 * cannot fail, and the suite says so.
 *
 * HOW IT IS LOADED
 * ----------------
 * As a second `--require` preload alongside `instrument.cjs`, activated by
 * `NT_CANARY_POSITIVE_MUTANT=<name>`. Absent that variable it does nothing at
 * all, so the same file is safe to mount into a normal run — and it is
 * deliberately mounted read-only, from the harness, never baked into the image
 * under test.
 *
 * It wraps `http.createServer` so the mutation happens inside the request the
 * driver is measuring, before the application sees it. That is the only place
 * that gives the mutation the same event window as the request it must be
 * attributed to.
 *
 * GROUND TRUTH, INDEPENDENT OF THE THING BEING TESTED
 * ---------------------------------------------------
 * Each mutant appends what it actually did to `NT_CANARY_MUTANT_OUT`, a file
 * the instrument does not write and the verdict does not read. That file is
 * how the suite knows the forbidden action really happened, WITHOUT asking the
 * detector whose job is to notice it. Comparing "the mutant says it parsed a
 * body" against "the claim came back satisfied" is what makes a vanished claim
 * visible.
 * ========================================================================== */

"use strict";

const NAME = process.env.NT_CANARY_POSITIVE_MUTANT || "";
if (NAME) {
  const fs = require("node:fs");
  const http = require("node:http");
  const net = require("node:net");

  const OUT = process.env.NT_CANARY_MUTANT_OUT || "/instr/mutant.jsonl";
  const SUPA = process.env.SUPABASE_SERVER_URL || "http://nt-canary-sink:8000";
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const PGHOST = process.env.NT_CANARY_PG_HOST || "nt-canary-pg";
  const BROKER = process.env.NT_CANARY_BROKER_HOST || "paper-api.alpaca.markets";

  const truth = (action, detail) => {
    try {
      fs.appendFileSync(OUT, JSON.stringify({
        t: Date.now(), mutant: NAME, action, detail,
      }) + "\n");
    } catch { /* best effort; the run still has the claim records */ }
  };

  const timeout = () => AbortSignal.timeout(4000);
  const swallow = (p) => p.then(() => {}, () => {});

  /* Each mutant is `async (req, res) => boolean`; returning true means it has
   * already answered the request and the application must not run. */
  const MUTANTS = {
    // -> noBodyParse
    //
    // Deliberately does NOT drain the incoming socket. An earlier version read
    // `req` to end before handing it on; the application then waited forever
    // for a body that had already been consumed, every request hit the
    // driver's 30s timeout, and the case took five minutes to say nothing. The
    // sensor under test is `Request.prototype.{json,text,…}`, which is
    // exercised by any Request — where the bytes came from is irrelevant to it.
    async parse_body(req) {
      const r = new Request("http://nt-canary-app" + (req.url || "/mutant"), {
        method: "POST",
        body: JSON.stringify({ mutant: "parse_body" }),
        headers: { "Content-Type": "application/json" },
      });
      const parsed = await r.json();
      truth("body.parsed", { url: req.url, keys: Object.keys(parsed) });
      return false;
    },

    // -> noSupabaseClient
    async create_supabase_client() {
      // The app's own factory reads exactly these two, and the env sensor
      // watches exactly these two.
      const url = process.env.SUPABASE_SERVER_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const client = { url, headers: { apikey: key, Authorization: `Bearer ${key}` } };
      truth("supabase.client.constructed", { urlPresent: Boolean(url), keyLength: (key || "").length });
      globalThis.__nt_canary_mutant_client = client;
      return false;
    },

    // -> noAuthCall  (and proxyRefusedBeforeAuth)
    async auth_get_user() {
      await swallow(fetch(`${SUPA}/auth/v1/user`, {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
        signal: timeout(),
      }));
      truth("auth.getUser", { url: `${SUPA}/auth/v1/user` });
      return false;
    },

    // -> noPostgRESTCall
    async postgrest_traffic() {
      await swallow(fetch(`${SUPA}/rest/v1/accounts?select=id&limit=1`, {
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
        signal: timeout(),
      }));
      truth("postgrest.select", { table: "accounts" });
      return false;
    },

    // -> noPostgRESTCall / noDatabaseCall
    async execute_rpc() {
      await swallow(fetch(`${SUPA}/rest/v1/rpc/owns_account`, {
        method: "POST",
        headers: {
          apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ acct: "22222222-2222-4222-8222-222222222222" }),
        signal: timeout(),
      }));
      truth("rpc.executed", { fn: "owns_account" });
      return false;
    },

    // -> noDatabaseCall (a socket straight at postgres, bypassing the gateway)
    async database_socket() {
      await new Promise((resolve) => {
        const s = net.connect({ host: PGHOST, port: 5432 });
        const done = () => { try { s.destroy(); } catch { /* closed */ } resolve(); };
        s.setTimeout(3000, done);
        s.on("connect", done);
        s.on("error", done);
      });
      truth("db.socket", { host: PGHOST, port: 5432 });
      return false;
    },

    // -> noVaultCall (a real call to a tombstoned wrapper, through the gateway)
    async vault_wrapper() {
      await swallow(fetch(`${SUPA}/rest/v1/rpc/vault_delete_secret`, {
        method: "POST",
        headers: {
          apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_id: "00000000-0000-4000-8000-0000000000ff" }),
        signal: timeout(),
      }));
      truth("vault.wrapper.invoked", { fn: "vault_delete_secret" });
      return false;
    },

    // -> noBrokerCall / noUnexpectedNetworkCall
    async broker_client() {
      await swallow(fetch(`https://${BROKER}/v2/account`, {
        headers: { "APCA-API-KEY-ID": "NOT-A-REAL-KEY", "APCA-API-SECRET-KEY": "NOT-A-REAL-SECRET" },
        signal: timeout(),
      }));
      truth("broker.called", { host: BROKER });
      return false;
    },

    // -> expectedResponseClass / proxyRefusedBeforeAuth
    async respond_401(req, res) {
      truth("responded.401", { url: req.url });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    },

    // -> refusalIdentity  (and NOT expectedResponseClass: that is the point)
    //
    // The audit's B6 case, made executable. This answers with a 503 that is not
    // the freeze refusal — the frozen proxy's own "Authentication service
    // temporarily unavailable" branch, same status, same Cache-Control, none of
    // the artifact identity. Under the old claim set it was indistinguishable
    // from containment working. `expectedResponseClass` must stay SATISFIED
    // here and `refusalIdentity` must go VIOLATED, or the new claim is just a
    // second copy of the status check.
    async respond_503_unrelated(req, res) {
      truth("responded.503.unrelated", { url: req.url });
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Authentication service temporarily unavailable" }));
      return true;
    },

    // -> handlerNotReached
    async reach_handler(req) {
      // Load and invoke a mutating route module directly, which is exactly
      // what "the handler was reached" means to the route-chunk sensor.
      const path = require("node:path");
      const root = "/app/.next/server/app/api";
      const stack = [root];
      let target = null;
      while (stack.length && !target) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name === "route.js" && /accounts/.test(full)) { target = full; break; }
        }
      }
      if (!target) { truth("handler.reach.failed", { reason: "no accounts route chunk found" }); return false; }
      // The chunk must be EVICTED first. Next's production server loads every
      // route module during boot, so a bare `require` of one is a module-cache
      // hit: it executes nothing, and the route-chunk sensor correctly read
      // zero while this mutant claimed it had reached a handler. Evicting and
      // re-requiring runs the module body for real, which is what the sensor
      // measures.
      let resolved = target;
      try { resolved = require.resolve(target); } catch { /* use the path */ }
      const cached = Object.prototype.hasOwnProperty.call(require.cache, resolved);
      delete require.cache[resolved];
      try {
        require(target);
        truth("handler.reached", { chunk: target, wasCached: cached });
      } catch (e) {
        // Loading and throwing still EXECUTED the chunk, which is the thing
        // the sensor measures; record honestly which happened.
        truth("handler.reached", { chunk: target, wasCached: cached, threw: String(e && e.message) });
      }
      return false;
    },
  };

  const mutate = MUTANTS[NAME];
  if (!mutate) {
    // A typo must not silently produce a clean run that looks like a control.
    // eslint-disable-next-line no-console
    console.error(`positive-mutants: unknown mutant '${NAME}'; known: ${Object.keys(MUTANTS).join(", ")}`);
    process.exit(97);
  }
  try { fs.appendFileSync(OUT, JSON.stringify({ t: Date.now(), mutant: NAME, action: "armed" }) + "\n"); }
  catch { /* best effort */ }

  const realCreate = http.createServer;
  http.createServer = function instrumentedCreateServer(...args) {
    const handler = args.find((a) => typeof a === "function");
    const opts = typeof args[0] === "object" ? args[0] : undefined;
    if (!handler) return realCreate.apply(this, args);
    const wrapped = async (req, res) => {
      // Only the endpoints the matrix drives; the readiness probe must stay
      // clean or the container never comes up.
      if (String(req.url || "").startsWith("/api/health")) return handler(req, res);
      let answered = false;
      try { answered = await mutate(req, res); }
      catch (e) { truth("mutant.error", { message: String(e && e.message) }); }
      if (!answered) return handler(req, res);
      return undefined;
    };
    return opts ? realCreate.call(this, opts, wrapped) : realCreate.call(this, wrapped);
  };
}
