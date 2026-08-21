/* ==========================================================================
 * sink.mjs — the recording Supabase gateway the image under test is pointed at
 *
 * The dashboard reaches "Supabase" over one origin: `SUPABASE_SERVER_URL`. In
 * the canary stack that origin is this process, on a docker network with no
 * route to anything else. Three things follow.
 *
 *  1. IT IS THE GROUND TRUTH FOR "ZERO AUTH CALLS" AND "ZERO POSTGREST/RPC
 *     CALLS". Those claims are about requests leaving the image, and every one
 *     of them has to arrive here. Unlike the in-process instrument, this
 *     observer does not depend on any patch surviving Next's bundling or its
 *     separate edge realm — the proxy's `supabase.auth.getUser()` runs in a
 *     sandbox with its own globals, and it still has to open a socket to this
 *     port. An empty log here is a fact about the network.
 *
 *  2. IT MAKES THE MUTANT'S CALLS REAL. Property (B) needs the unfrozen image
 *     to actually reach `vault_delete_secret` in the database, so the RPC and
 *     table endpoints are forwarded to the disposable Postgres clone rather
 *     than answered with a canned response. A stub would prove only that the
 *     mutant tried.
 *
 *  3. IT TAGS THE CANARY ROW. Before forwarding, it sets the
 *     `nt_canary.cell` GUC to whatever matrix cell the driver announced, so a
 *     canary row identifies the cell that produced it directly instead of
 *     being matched to one by timestamp.
 *
 *  4. IT IS THE WITNESS FOR *WHICH MIGRATION GENERATION* WAS RUNNING.
 *     Audit finding B1: a cell result carried no generation marker at all. The
 *     schema appeared only in the filename prefix that `verdict.mjs` itself
 *     supplied when it globbed `result-<schema>-*`, so one generation's 24
 *     result files, copied onto the other generation's filenames, satisfied
 *     every check the cell-identity gate added — filename, the driver's own
 *     `cell` field, `cellTag`s and `instrumentEnv.raw_freeze_flags` are all
 *     generation-independent. Twenty-four driven combinations certified as
 *     forty-eight, and the pre-tombstone 0008 database need never have existed.
 *
 *     `/__canary/generation` answers that question from the ONE place that
 *     cannot be renamed: the running database's own catalogue. It is served by
 *     this process — a different container from the driver that writes the cell
 *     result and a different container from the image under test — and the
 *     answer is written BOTH into the reply the driver records AND into this
 *     gateway's own log file on the host, so a forger has to keep two
 *     independently-produced files consistent instead of editing one.
 *
 * TOKENS. Every JWT this gateway accepts was minted by `driver/keys.mjs` with
 * a signing secret that is a literal string saying it is not a secret, and the
 * signature is verified so a token from anywhere else is refused. There is no
 * configuration in which a real Supabase credential works here.
 *
 * LOGGING. Headers are recorded by NAME with a length and an 8-hex-character
 * digest. No `Authorization`, `apikey` or `Cookie` value is ever written to
 * the log, printed, or returned.
 * ========================================================================== */

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const PORT = Number(process.env.SINK_PORT || 8000);
const LOG = process.env.SINK_LOG || "/out/sink.jsonl";
const PGHOST = process.env.SINK_PGHOST || "nt-canary-pg";
// `authenticator` is the role PostgREST itself connects as in a real Supabase
// project, and the one permitted to `set local role` to anon / authenticated /
// service_role. Using it keeps the privilege story identical to production's.
const PGUSER = process.env.SINK_PGUSER || "authenticator";
const JWT_SECRET = process.env.SINK_JWT_SECRET || "nt-runtime-canary-not-a-secret-signing-key";
const PROBE_USER_ID = process.env.SINK_PROBE_USER_ID || "33333333-3333-4333-8333-333333333333";
const PROBE_USER_EMAIL = process.env.SINK_PROBE_USER_EMAIL || "runtime-canary-probe@example.invalid";

const SENSITIVE = new Set(["authorization", "apikey", "cookie", "set-cookie", "x-client-info"]);

let cell = "(unset)";
let seq = 0;

const pool = new pg.Pool({
  host: PGHOST,
  port: 5432,
  user: PGUSER,
  database: "postgres",
  max: 4,
  // trust auth in the disposable clone; there is no password to leak
  // The image's own pg_hba requires scram-sha-256 off loopback; 05_sink_role.sql
  // sets this literal on `authenticator`. It is not a credential and the
  // container it reaches is destroyed with the run.
  password: process.env.SINK_PGPASSWORD || "nt-runtime-canary-not-a-credential",
});

function digest(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 8);
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    out[key] = SENSITIVE.has(key)
      ? { redacted: true, length: String(v).length, sha256_8: digest(v) }
      : v;
  }
  return out;
}

function record(entry) {
  const row = { seq: ++seq, t: Date.now(), cell, ...entry };
  try { fs.appendFileSync(LOG, JSON.stringify(row) + "\n"); } catch { /* best effort */ }
  return row;
}

/* --- the migration-generation witness ------------------------------------
 * A fingerprint of the SHAPE of `public` as the running server reports it:
 * every relation's columns, every routine's identity signature, every
 * constraint. Deliberately structural rather than behavioural, so that it is:
 *
 *   - DIFFERENT between 0001-0008 and 0001-0023 (7 routines vs 44, 142
 *     relation-columns vs 206 — the generations are not close);
 *   - IDENTICAL across the 24 cells of one generation, because it reads no row
 *     data, and the mutant's per-cell probe-account reset moves rows only;
 *   - UNCHANGED by the harness's own installation, which was verified rather
 *     than assumed: `05_sink_role.sql`, `15_probe_identity.sql` and
 *     `20_canary_install.sql` applied to a 0023 fixture leave the fingerprint
 *     byte-identical, because the canary re-creates the three `public.vault_*`
 *     wrappers with the schema's own signatures and puts everything else it
 *     builds in the `nt_canary` schema.
 *
 * Every `::text` cast here is load-bearing: `relkind`, `contype` and `prokind`
 * are `"char"`, and `text || "char"` is ambiguous — the first version of this
 * query died on `operator is not unique`, which is the same footgun as the
 * `text[] || 'literal'` defect recorded in the README.
 */
const GENERATION_SQL = `
with lines as (
  select format('rel|%s|%s|%s|%s|%s', c.relname, c.relkind::text, a.attnum::text, a.attname,
                format_type(a.atttypid, a.atttypmod)) as line
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
  union all
  select format('fn|%s(%s)|%s', p.proname, pg_get_function_identity_arguments(p.oid), p.prokind::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
  union all
  select format('con|%s|%s', co.conname, co.contype::text)
    from pg_constraint co join pg_namespace n on n.oid = co.connamespace
   where n.nspname = 'public'
)
select md5(string_agg(line, E'\\n' order by line))                as fingerprint,
       count(*) filter (where line like 'rel|%')::int             as relation_columns,
       count(*) filter (where line like 'fn|%')::int              as routines,
       count(*) filter (where line like 'con|%')::int             as constraints,
       count(*)::int                                              as total_lines
  from lines`;

async function observeGeneration() {
  const r = await pool.query(GENERATION_SQL);
  const row = r.rows[0] || {};
  if (!row.fingerprint || !row.total_lines) {
    throw new Error("the generation query returned no catalogue lines; an empty scan is not a fingerprint");
  }
  return {
    observedBy: "sink",
    pgHost: PGHOST,
    at: new Date().toISOString(),
    fingerprint: String(row.fingerprint),
    facts: {
      relation_columns: Number(row.relation_columns),
      routines: Number(row.routines),
      constraints: Number(row.constraints),
      total_lines: Number(row.total_lines),
    },
  };
}

/* THE LABEL THIS GATEWAY WRITES. IT IS NOT WHAT DECIDES ANYTHING.
 *
 * The verdict re-derives the class from `path` on the host side
 * (driver/claims.mjs classifyGatewayPath), because until round 8 the claim
 * filters read this label off the row and deleting the field from one line
 * bought a certifying PASS over a recorded GET /rest/v1/accounts. The table is
 * kept identical to the host-side one so an honest row is self-consistent and
 * a row that disagrees with its own path is refused as a contradiction.
 *
 * It is also TOTAL over the Supabase surface now. It used to answer "other"
 * for /storage/v1, /realtime/v1, /functions/v1, /graphql/v1 and /pg — the four
 * surfaces the Stage 2 edge exists to deny plus pg-meta — and no claim on
 * either observer read "other", so a row on any of them satisfied all sixteen
 * claims. This gateway 404s them all (see the final send below); the point of
 * naming them is that the RECORD says which surface was attempted. */
function classify(pathname) {
  if (pathname === null || pathname === undefined || pathname === "") return "unclassified";
  if (pathname.startsWith("/auth/v1")) return "auth";
  if (pathname.startsWith("/rest/v1/rpc/")) return "rpc";
  if (pathname.startsWith("/rest/v1")) return "postgrest";
  if (pathname.startsWith("/graphql/v1")) return "graphql";
  if (pathname.startsWith("/storage/v1")) return "storage";
  if (pathname.startsWith("/realtime/v1")) return "realtime";
  if (pathname.startsWith("/functions/v1")) return "functions";
  if (pathname === "/pg" || pathname.startsWith("/pg/")) return "pg";
  if (pathname.startsWith("/__canary")) return "harness";
  if (pathname === "/") return "kong";
  return "unclassified";
}

/** Verify one of our own HS256 tokens. Returns the payload, or null. */
function verifyJwt(token) {
  if (!token || token.split(".").length !== 3) return null;
  const [h, p, s] = token.split(".");
  const expect = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${h}.${p}`)
    .digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // Constant-time compare so the gateway does not become a timing oracle for
  // a token that, admittedly, is printed in the repository anyway.
  const a = Buffer.from(s), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
}

function bearer(req) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const apikey = req.headers["apikey"];
  return typeof apikey === "string" ? apikey.trim() : null;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/* --- PostgREST filter grammar, the subset supabase-js actually emits ------ */
const OPS = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike",
};

function buildWhere(params, values) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    const m = /^([a-z]+)\.(.*)$/s.exec(raw);
    if (!m) continue;
    const [, op, rhs] = m;
    if (op === "is") {
      clauses.push(`"${key}" is ${rhs === "null" ? "null" : rhs === "true" ? "true" : "false"}`);
    } else if (op === "in") {
      const list = rhs.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
      const ph = list.map((v) => { values.push(v.replace(/^"|"$/g, "")); return `$${values.length}`; });
      clauses.push(`"${key}" in (${ph.join(",")})`);
    } else if (OPS[op]) {
      values.push(rhs);
      clauses.push(`"${key}" ${OPS[op]} $${values.length}`);
    }
  }
  return clauses.length ? " where " + clauses.join(" and ") : "";
}

function selectList(params) {
  const sel = params.get("select");
  if (!sel || sel === "*") return "*";
  // Only plain column lists are needed here; embedded resources are not used
  // by any handler in this image, and guessing at them would be worse than
  // refusing them.
  if (/[()!:]/.test(sel)) return "*";
  return sel.split(",").map((c) => `"${c.trim()}"`).join(", ");
}

function orderBy(params) {
  const o = params.get("order");
  if (!o) return "";
  const parts = o.split(",").map((p) => {
    const [col, ...mods] = p.split(".");
    const dir = mods.includes("desc") ? "desc" : "asc";
    return `"${col}" ${dir}`;
  });
  return " order by " + parts.join(", ");
}

/** The only three roles PostgREST ever switches to. Anything else is a bug. */
const SAFE_ROLES = new Set(["service_role", "authenticated", "anon"]);

async function withRole(role, claims, fn) {
  if (!SAFE_ROLES.has(role)) throw new Error(`refusing to switch to role ${role}`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    // `set local role` is what PostgREST issues, and it is what makes
    // `current_setting('role')` — the value the canary replays the ACL
    // against — the caller's own role rather than the connection's.
    await client.query(`set local role "${role}"`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [String(claims.sub ?? "")]);
    // The cell tag the canary reads, so a hit names the matrix cell directly.
    await client.query("select set_config('nt_canary.cell', $1, true)", [cell]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* connection already broken */ }
    throw e;
  } finally {
    client.release();
  }
}

function pgErrorResponse(e) {
  const code = e && e.code ? String(e.code) : "XX000";
  const status = code === "42501" ? 403 : code === "P0001" ? 400 : code === "42883" ? 404 : 400;
  return {
    status,
    body: {
      code,
      message: e && e.message ? String(e.message) : "database error",
      details: null,
      hint: null,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://sink");
  const body = await readBody(req);
  const kind = classify(url.pathname);

  const send = (status, payload, extraHeaders = {}, extraLog = null) => {
    const text = payload === null || payload === undefined ? "" : JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
    res.end(text);
    record({
      kind,
      method: req.method,
      path: url.pathname,
      query: url.search,
      status,
      reqBodyBytes: body.length,
      headers: redactHeaders(req.headers),
      ...(extraLog || {}),
    });
  };

  // --- harness control ----------------------------------------------------
  if (url.pathname === "/__canary/cell") {
    try { cell = JSON.parse(body.toString("utf8")).cell || "(unset)"; } catch { cell = "(unset)"; }
    return send(200, { cell });
  }
  // The generation witness. Read out of the running database on every call —
  // never cached — so the answer belongs to the cell that asked for it.
  if (url.pathname === "/__canary/generation") {
    try {
      const w = await observeGeneration();
      // Recorded in the gateway's OWN log as well as returned. The two files are
      // written by two different containers, which is the whole point: the
      // driver cannot manufacture the sink's copy by editing its own.
      return send(200, w, {}, { witness: { fingerprint: w.fingerprint, facts: w.facts } });
    } catch (e) {
      return send(500, { error: String((e && e.message) || e) }, {},
        { witness: { error: String((e && e.message) || e) } });
    }
  }
  /* THE SECOND COPY OF WHAT EACH REQUEST OBSERVED (audit findings B and C).
   *
   * The cell result used to be the only record of a request's status, headers,
   * body, timings, instrument events and coverage markers. Two forgeries
   * certified a PASS by copying those records between cells and between
   * migration generations, using nothing but values already present in the
   * artefact directory — and no check could tell a copy from the truth,
   * because a frozen image refuses every request identically.
   *
   * The driver now hands this gateway the canonical description of each
   * request the moment it finishes, and it is written verbatim into this
   * container's OWN log. `verdict.mjs` recomputes the description from the
   * cell result and requires equality, so an artefact directory edited after
   * the run contradicts a file the editor did not write.
   *
   * This endpoint stores nothing and decides nothing: it is a witness. An
   * unparseable body is recorded AS unparseable rather than dropped, because a
   * missing observation and a malformed one must not look the same. */
  if (url.pathname === "/__canary/observe") {
    let o = null;
    let parseError = null;
    try { o = JSON.parse(body.toString("utf8")); }
    catch (e) { parseError = String((e && e.message) || e); }
    if (!o || typeof o !== "object" || typeof o.digest !== "string") {
      return send(400, { recorded: false }, {},
        { observation: { error: parseError || "no digest in the observation", cellAtGateway: cell } });
    }
    return send(200, { recorded: true, digest: o.digest }, {},
      { observation: { ...o, cellAtGateway: cell } });
  }
  if (url.pathname === "/__canary/health") {
    try {
      const r = await pool.query("select 1 as ok");
      return send(200, { ok: r.rows[0].ok === 1, cell });
    } catch (e) {
      return send(500, { ok: false, error: String(e.message) });
    }
  }

  const token = bearer(req);
  const claims = verifyJwt(token);

  // --- GoTrue -------------------------------------------------------------
  if (kind === "auth") {
    if (url.pathname === "/auth/v1/user" || url.pathname === "/auth/v1/user/") {
      if (!claims || !claims.sub) {
        return send(401, { code: 401, error_code: "bad_jwt", msg: "invalid claim: missing sub claim" });
      }
      return send(200, {
        id: claims.sub,
        aud: "authenticated",
        role: "authenticated",
        email: claims.email || PROBE_USER_EMAIL,
        email_confirmed_at: "2026-01-01T00:00:00Z",
        phone: "",
        confirmed_at: "2026-01-01T00:00:00Z",
        last_sign_in_at: "2026-01-01T00:00:00Z",
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: { display_name: "Runtime Canary Probe" },
        identities: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        is_anonymous: false,
      });
    }
    if (url.pathname === "/auth/v1/settings") {
      return send(200, { external: {}, disable_signup: true, mailer_autoconfirm: true });
    }
    // Anything else: refused, and recorded. A refresh attempt is still an Auth
    // call and must appear in the log as one.
    return send(400, { error: "unsupported_grant_type", error_description: "the canary sink mints no new tokens" });
  }

  // --- PostgREST ----------------------------------------------------------
  if (kind === "rpc" || kind === "postgrest") {
    if (!claims) return send(401, { message: "no API key found in request", code: "401" });
    const role = claims.role === "service_role" ? "service_role"
      : claims.role === "authenticated" ? "authenticated" : "anon";

    try {
      if (kind === "rpc") {
        const fn = url.pathname.slice("/rest/v1/rpc/".length);
        if (!/^[a-z_][a-z0-9_]*$/i.test(fn)) return send(400, { message: "bad function name" });
        let args = {};
        try { args = body.length ? JSON.parse(body.toString("utf8")) : {}; } catch { /* empty */ }
        const names = Object.keys(args);
        const values = names.map((n) => args[n]);
        const call = names.length
          ? names.map((n, i) => `"${n}" := $${i + 1}`).join(", ")
          : "";
        const sql = `select public."${fn}"(${call}) as result`;
        const out = await withRole(role, claims, (c) => c.query(sql, values));
        const value = out.rows[0] ? out.rows[0].result : null;
        return send(200, value === undefined ? null : value);
      }

      const table = url.pathname.slice("/rest/v1/".length).split("/")[0];
      if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return send(400, { message: "bad table name" });
      const params = [...url.searchParams.entries()];
      const wantsObject = String(req.headers["accept"] || "").includes("vnd.pgrst.object");
      const prefer = String(req.headers["prefer"] || "");
      const values = [];
      let sql;

      if (req.method === "GET" || req.method === "HEAD") {
        const where = buildWhere(params, values);
        sql = `select ${selectList(url.searchParams)} from public."${table}"${where}${orderBy(url.searchParams)}`;
      } else if (req.method === "POST") {
        const payload = JSON.parse(body.toString("utf8") || "{}");
        const rows = Array.isArray(payload) ? payload : [payload];
        const cols = Object.keys(rows[0] || {});
        const tuples = rows.map((r) => "(" + cols.map((c) => { values.push(r[c]); return `$${values.length}`; }).join(",") + ")");
        sql = `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(",")}) values ${tuples.join(",")}`;
        if (prefer.includes("return=representation")) sql += ` returning ${selectList(url.searchParams)}`;
      } else if (req.method === "PATCH") {
        const payload = JSON.parse(body.toString("utf8") || "{}");
        const sets = Object.keys(payload).map((c) => { values.push(payload[c]); return `"${c}" = $${values.length}`; });
        const where = buildWhere(params, values);
        sql = `update public."${table}" set ${sets.join(", ")}${where}`;
        if (prefer.includes("return=representation")) sql += ` returning ${selectList(url.searchParams)}`;
      } else if (req.method === "DELETE") {
        const where = buildWhere(params, values);
        sql = `delete from public."${table}"${where}`;
        if (prefer.includes("return=representation")) sql += ` returning ${selectList(url.searchParams)}`;
      } else {
        return send(405, { message: `method ${req.method} not emulated` });
      }

      const out = await withRole(role, claims, (c) => c.query(sql, values));
      const rows = out.rows || [];
      if (wantsObject) {
        if (rows.length !== 1) {
          return send(406, {
            code: "PGRST116",
            message: `JSON object requested, multiple (or no) rows returned`,
            details: `Results contain ${rows.length} rows`,
          });
        }
        return send(200, rows[0]);
      }
      return send(req.method === "POST" ? 201 : 200, rows);
    } catch (e) {
      const mapped = pgErrorResponse(e);
      return send(mapped.status, mapped.body);
    }
  }

  /* Every other Supabase surface reaches here and is refused — but the refusal
   * is RECORDED with its derived class (storage/realtime/functions/graphql/pg/
   * kong/unclassified) rather than as an anonymous "other", so the verdict can
   * see which surface the image under test reached for. */
  return send(404, { error: "the canary sink serves only /auth/v1, /rest/v1 and /__canary" });
});

server.listen(PORT, "0.0.0.0", () => {
  record({ kind: "harness", method: "-", path: "/__canary/started", status: 0, reqBodyBytes: 0, headers: {} });
  process.stdout.write(`sink listening on ${PORT}, forwarding to ${PGHOST}\n`);
});
