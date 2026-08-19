#!/usr/bin/env node
/**
 * Enumerate every API route from disk and derive, per route, the exact set of
 * database objects it can touch.
 *
 * Why this exists
 * ---------------
 * The bridge image has to deploy against a database that may still be at
 * migration 0008 *or* already at 0023. A previous review concluded from
 * reading the migrations and grepping the ported code that the bridge names no
 * post-0008 object. That conclusion is only as good as the grep: it covers the
 * objects someone thought to search for, in the files someone thought to open.
 *
 * This tool replaces the grep with an enumeration:
 *
 *   1. routes are discovered from the filesystem, not from a hand-written list;
 *   2. each route's *transitive* local import closure is walked, because every
 *      real database call lives in `lib/`, not in the route file;
 *   3. every `.from(...)` / `.rpc(...)` in that closure must resolve to a
 *      string literal. One that does not is a hard error, not a skipped line —
 *      an object this tool cannot name is an object the schema check cannot
 *      prove, and silently dropping it is exactly the hole being closed.
 *
 * Output: JSON on stdout (see `--help`), plus optional SQL/`objects` sidecars
 * for the catalogue check in run.sh.
 */

import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    die(`${name} requires a value`);
  }
  return v;
}
function die(msg) {
  process.stderr.write(`extract-route-objects: ${msg}\n`);
  process.exit(2);
}

if (args.includes("--help")) {
  process.stdout.write(
    [
      "usage: extract-route-objects.mjs --dashboard <dir> [--out-json f] [--out-sql f]",
      "",
      "  --dashboard  the dashboard/ directory (contains app/ and lib/)",
      "  --out-json   write the full report here as well as stdout",
      "  --out-sql    write a psql VALUES fragment naming every wanted object",
      "  --extra-route <file>  additionally treat <file> as an entrypoint",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const DASHBOARD = resolve(flag("--dashboard") ?? die("--dashboard is required"));
const OUT_JSON = flag("--out-json");
const OUT_SQL = flag("--out-sql");
const EXTRA_ROUTES = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--extra-route") EXTRA_ROUTES.push(resolve(args[i + 1]));
}

const API_ROOT = join(DASHBOARD, "app", "api");

// ---------------------------------------------------------------------------
// 1. Route discovery — from disk, never from a list
// ---------------------------------------------------------------------------

/** Every file under app/api, so nothing can hide from the classifier. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

const ROUTE_BASENAMES = new Set([
  "route.ts",
  "route.tsx",
  "route.js",
  "route.mjs",
]);

const allApiFiles = walk(API_ROOT);
const routeFiles = [];
const testFiles = [];
const unclassified = [];
for (const f of allApiFiles) {
  const base = f.slice(f.lastIndexOf(sep) + 1);
  if (ROUTE_BASENAMES.has(base)) routeFiles.push(f);
  else if (/\.test\.tsx?$/.test(base)) testFiles.push(f);
  else unclassified.push(f);
}
// A file under app/api that is neither a route nor a test is something this
// tool does not understand. Refusing to guess is the point.
if (unclassified.length > 0) {
  die(
    "unclassified files under app/api (neither a Next.js route file nor a " +
      `test): ${unclassified.map((f) => relative(DASHBOARD, f)).join(", ")}`,
  );
}
for (const extra of EXTRA_ROUTES) routeFiles.push(extra);
routeFiles.sort();

if (routeFiles.length === 0) die(`no route files found under ${API_ROOT}`);

// ---------------------------------------------------------------------------
// 2. Comment stripping that respects string and template literals
// ---------------------------------------------------------------------------

/**
 * Re-exported, not reimplemented. This module had the seventh independent copy
 * of comment-stripping in the tree; they are now one definition, parsed by the
 * TypeScript compiler rather than approximated by hand.
 */
export { stripComments } from "../containment/source-scan.mjs";

// ---------------------------------------------------------------------------
// 3. Import resolution (local modules only)
// ---------------------------------------------------------------------------

const CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".mjs",
  "/index.ts",
  "/index.tsx",
];

function resolveLocal(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(DASHBOARD, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../"))
    base = resolve(dirname(fromFile), spec);
  else return null; // bare package specifier — not our code
  for (const suffix of CANDIDATE_SUFFIXES) {
    const cand = base + suffix;
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

const IMPORT_RE =
  /(?:^|[\s;}])(?:import|export)\s(?:[^;'"]*?\sfrom\s)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function importSpecs(code) {
  const specs = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

const codeCache = new Map();
function codeOf(file) {
  if (!codeCache.has(file)) {
    codeCache.set(file, stripComments(readFileSync(file, "utf8"), file));
  }
  return codeCache.get(file);
}

/** Transitive local import closure of one route, excluding test files. */
function closureOf(routeFile) {
  const seen = new Set();
  const queue = [routeFile];
  const unresolvedBare = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importSpecs(codeOf(file))) {
      const target = resolveLocal(spec, file);
      if (target === null) {
        if (spec.startsWith("@/") || spec.startsWith("."))
          die(`cannot resolve local import ${spec} from ${file}`);
        unresolvedBare.add(spec);
        continue;
      }
      if (/\.test\.tsx?$/.test(target)) continue;
      queue.push(target);
    }
  }
  return { files: [...seen].sort(), packages: [...unresolvedBare].sort() };
}

// ---------------------------------------------------------------------------
// 4. Database-object extraction
// ---------------------------------------------------------------------------

/**
 * Receivers whose `.from` is a JavaScript builtin, not a PostgREST table.
 * Anything not on this list must produce a string-literal argument or the run
 * fails: an unrecognised `.from()` is a possible table this tool would
 * otherwise drop on the floor.
 */
const BUILTIN_FROM_RECEIVERS = new Set([
  "Buffer",
  "Array",
  "Object",
  "String",
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/** `svc.from("accounts")`, tolerating a line break before the dot. */
const CALL_RE =
  /([A-Za-z_$][\w$]*)\s*\.\s*(from|rpc)\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*[,)]/g;
/** Every `.from(` / `.rpc(` at all, for the "nothing was skipped" assertion. */
const ANY_CALL_RE = /\.\s*(from|rpc)\s*\(/g;

/**
 * How the Supabase client held by `name` authenticates, decided from its
 * binding in the same file.
 *
 *   service_role  — getSupabaseService(): bypasses RLS, holds the privileged grants
 *   authenticated — getSupabaseServer():  the signed-in user's cookie session
 *   anon          — a browser client
 *   caller        — a function parameter; the role comes from whoever calls it
 */
function clientRoles(code) {
  const roles = new Map();
  const bind = (re, role) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) roles.set(m[1], role);
  };
  bind(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?getSupabaseService\s*\(/g,
    "service_role",
  );
  bind(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?getSupabaseServer\s*\(/g,
    "authenticated",
  );
  bind(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:getSupabaseBrowser|createBrowserClient)\s*\(/g,
    "anon",
  );
  // `svc: Service` / `svc: SupabaseClient<Database>` as a parameter.
  bind(
    /([A-Za-z_$][\w$]*)\s*:\s*(?:Service|SupabaseClient\b)/g,
    "caller-supplied",
  );
  return roles;
}

function extractCalls(file) {
  const code = codeOf(file);
  const roles = clientRoles(code);
  const found = [];
  let matchedSpans = 0;

  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(code)) !== null) {
    const [, receiver, method, dq, sq, raw] = m;
    if (BUILTIN_FROM_RECEIVERS.has(receiver)) {
      matchedSpans++;
      continue;
    }
    const literal = dq !== undefined ? dq : sq;
    if (literal === undefined) {
      die(
        `${relative(DASHBOARD, file)}: ${receiver}.${method}(${(raw ?? "").trim()}) ` +
          "does not name its object with a string literal; the schema check " +
          "cannot prove an object it cannot name",
      );
    }
    matchedSpans++;
    const line = code.slice(0, m.index).split("\n").length;
    found.push({
      file: relative(DASHBOARD, file),
      line,
      receiver,
      kind: method === "from" ? "relation" : "function",
      object: literal,
      role: roles.get(receiver) ?? "unknown",
    });
  }

  // Nothing was skipped: every `.from(`/`.rpc(` token in the file was consumed
  // by the classifier above.
  ANY_CALL_RE.lastIndex = 0;
  let total = 0;
  while (ANY_CALL_RE.exec(code) !== null) total++;
  if (total !== matchedSpans) {
    die(
      `${relative(DASHBOARD, file)}: found ${total} .from()/.rpc() call sites ` +
        `but classified only ${matchedSpans}; refusing to report a partial surface`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// 5. Resolve `caller-supplied` roles one level up, inside each closure
// ---------------------------------------------------------------------------

/**
 * For a call whose receiver is a function parameter, find the callers of the
 * enclosing exported function inside the same route closure and take the role
 * of the client they pass. Unresolvable stays `unknown` and is reported as
 * such rather than guessed.
 */
function resolveCallerRole(call, closureFiles) {
  const defCode = codeOf(join(DASHBOARD, call.file));
  // Name of the exported function whose parameter list declares the receiver.
  const declRe = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*${call.receiver}\\s*:`,
  );
  const decl = declRe.exec(defCode);
  if (decl === null) return "unknown";
  const fnName = decl[1];

  const roles = new Set();
  for (const f of closureFiles) {
    const code = codeOf(f);
    const callerRoles = clientRoles(code);
    const useRe = new RegExp(
      `\\b${fnName}\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*[,)]`,
      "g",
    );
    let m;
    while ((m = useRe.exec(code)) !== null) {
      const r = callerRoles.get(m[1]);
      if (r !== undefined && r !== "caller-supplied") roles.add(r);
    }
  }
  if (roles.size === 1) return `${[...roles][0]} (via ${fnName})`;
  return "unknown";
}

// ---------------------------------------------------------------------------
// 6. Build the report
// ---------------------------------------------------------------------------

function routeName(file) {
  if (!file.startsWith(API_ROOT)) return relative(DASHBOARD, file);
  const parts = relative(API_ROOT, file).split(sep);
  return `/api/${parts.slice(0, -1).join("/")}`.replace(/\/$/, "") || "/api";
}

const routes = [];
for (const file of routeFiles) {
  const { files, packages } = closureOf(file);
  const calls = [];
  for (const f of files) {
    for (const call of extractCalls(f)) {
      if (call.role === "caller-supplied") {
        call.role = resolveCallerRole(call, files);
      }
      calls.push(call);
    }
  }
  calls.sort((a, b) =>
    `${a.kind}${a.object}${a.file}${a.line}`.localeCompare(
      `${b.kind}${b.object}${b.file}${b.line}`,
    ),
  );
  routes.push({
    route: routeName(file),
    file: relative(DASHBOARD, file),
    closureSize: files.length,
    closure: files.map((f) => relative(DASHBOARD, f)),
    packages,
    calls,
  });
}

const objects = new Map();
for (const r of routes) {
  for (const c of r.calls) {
    const key = `${c.kind}:${c.object}`;
    if (!objects.has(key)) {
      objects.set(key, {
        kind: c.kind,
        object: c.object,
        roles: new Set(),
        routes: new Set(),
      });
    }
    const o = objects.get(key);
    o.roles.add(c.role);
    o.routes.add(r.route);
  }
}
/**
 * The database roles that must be able to use an object, reduced from the
 * per-call-site attribution. `unknown` is deliberately dropped rather than
 * guessed: an unattributed call still requires the object to EXIST (which is
 * checked), it just cannot say under which grant, and inventing one would
 * produce either a false blocker or a false pass.
 */
const CONCRETE_ROLES = new Set(["service_role", "authenticated", "anon"]);
function concreteRole(role) {
  const head = String(role).split(" ")[0];
  return CONCRETE_ROLES.has(head) ? head : null;
}

const objectList = [...objects.values()]
  .map((o) => {
    const required = new Set();
    for (const r of o.roles) {
      const c = concreteRole(r);
      if (c !== null) required.add(c);
    }
    return {
      kind: o.kind,
      object: o.object,
      roles: [...o.roles].sort(),
      requiredRoles: [...required].sort(),
      routes: [...o.routes].sort(),
    };
  })
  .sort((a, b) => `${a.kind}:${a.object}`.localeCompare(`${b.kind}:${b.object}`));

const report = {
  dashboard: DASHBOARD,
  apiRoot: relative(DASHBOARD, API_ROOT),
  routeFileCount: routeFiles.length,
  testFilesUnderApi: testFiles.map((f) => relative(DASHBOARD, f)),
  routes,
  objects: objectList,
};

const json = JSON.stringify(report, null, 2);
process.stdout.write(json + "\n");
if (OUT_JSON) writeFileSync(OUT_JSON, json + "\n");

if (OUT_SQL) {
  if (objectList.length === 0) die("no database objects extracted — refusing to emit an empty check");
  const rows = objectList
    .map((o) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.object)) {
        die(`object name is not a plain identifier: ${JSON.stringify(o.object)}`);
      }
      return `    ('${o.object}', '${o.kind}', '${o.routes.join(" ")}', '${o.requiredRoles.join(" ")}')`;
    })
    .join(",\n");
  writeFileSync(
    OUT_SQL,
    `-- generated by extract-route-objects.mjs — do not edit\n` +
      `create temporary table wanted(obj_name text, obj_kind text, used_by text, req_roles text);\n` +
      `insert into wanted(obj_name, obj_kind, used_by, req_roles) values\n${rows};\n`,
  );
}
