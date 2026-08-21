/* ==========================================================================
 * enumerate-routes.mjs — every mutating method, from the route filesystem
 *
 * A hand-written list of endpoints is the standard way this proof goes wrong:
 * it is correct the day it is written and silently incomplete the day someone
 * adds a handler. So the matrix is generated from `app/api` on disk — the same
 * filesystem convention Next itself routes by — and the harness refuses to run
 * if the enumeration looks degenerate.
 *
 * Three export forms are recognised, because all three are valid Next route
 * handlers and a regex that knew only the first would under-report:
 *
 *     export async function POST(...) {}
 *     export const POST = ...
 *     export { handler as POST }
 *
 * Comments are stripped first, so a commented-out handler is not counted and,
 * more importantly, a real handler is not missed because a comment above it
 * mentioned another verb.
 *
 * Usage:
 *   node enumerate-routes.mjs --source <dashboard-dir> [--account-id <uuid>]
 *                             [--inject-selftest] [--out <file>]
 *
 * Exit codes:
 *   0  a plausible enumeration was produced
 *   2  the enumeration is degenerate (no routes, or no mutating methods) —
 *      which is never a pass, because an empty matrix trivially "proves" the
 *      freeze
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function args() {
  const a = process.argv.slice(2);
  const out = { accountId: "44444444-4444-4444-8444-444444444444", injectSelftest: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--source") out.source = a[++i];
    else if (a[i] === "--account-id") out.accountId = a[++i];
    else if (a[i] === "--out") out.out = a[++i];
    else if (a[i] === "--inject-selftest") out.injectSelftest = true;
    else { console.error(`enumerate-routes: unknown argument ${a[i]}`); process.exit(2); }
  }
  if (!out.source) { console.error("enumerate-routes: --source is required"); process.exit(2); }
  return out;
}

function stripComments(src) {
  // Block comments then line comments. Good enough for detecting exports, and
  // deliberately conservative: it can only remove text, never invent an export.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function methodsIn(src) {
  const clean = stripComments(src);
  const found = new Set();
  for (const m of ALL_METHODS) {
    const patterns = [
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`),
      new RegExp(`export\\s+(?:const|let|var)\\s+${m}\\s*[=:]`),
      new RegExp(`export\\s*\\{[^}]*\\b(?:as\\s+)?${m}\\b[^}]*\\}`),
    ];
    if (patterns.some((p) => p.test(clean))) found.add(m);
  }
  return [...found];
}

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/^route\.(ts|tsx|js|mjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

function urlFor(file, apiRoot, accountId) {
  const rel = path.relative(apiRoot, path.dirname(file));
  const segments = rel === "" ? [] : rel.split(path.sep);
  const out = [];
  for (const s of segments) {
    if (/^\(.*\)$/.test(s)) continue;                 // route group: not in the URL
    if (/^\[\[?\.\.\.(.+?)\]\]?$/.test(s)) { out.push("catchall"); continue; }
    const dyn = /^\[(.+?)\]$/.exec(s);
    out.push(dyn ? accountId : s);
  }
  return "/api" + (out.length ? "/" + out.join("/") : "");
}

const opts = args();
const apiRoot = path.join(opts.source, "app", "api");
if (!fs.existsSync(apiRoot)) {
  console.error(`enumerate-routes: ${apiRoot} does not exist`);
  process.exit(2);
}

const files = walk(apiRoot).sort();
const routes = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const methods = methodsIn(src);
  routes.push({
    file: path.relative(opts.source, file),
    url: urlFor(file, apiRoot, opts.accountId),
    methods: methods.sort(),
    mutating: methods.filter((m) => MUTATING.has(m)).sort(),
    dynamic: /\[[^\]]+\]/.test(path.relative(apiRoot, file)),
  });
}

// --- the extractor's own positive control ---------------------------------
// `--inject-selftest` adds a synthetic route file whose mutating verbs are
// known, and requires them to come back. If the parser silently stopped
// recognising an export form, every later "no mutating handler reached the
// database" would be true because nothing was ever driven.
if (opts.injectSelftest) {
  const tmp = fs.mkdtempSync("/tmp/nt-canary-selftest-");
  const dir = path.join(tmp, "app", "api", "nt-selftest");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "route.ts"), [
    "// export async function DELETE() {}   <- commented out, must NOT be found",
    "export async function POST() { return new Response('x'); }",
    "export const PATCH = async () => new Response('x');",
    "const h = async () => new Response('x');",
    "export { h as PUT };",
  ].join("\n"));
  const probe = methodsIn(fs.readFileSync(path.join(dir, "route.ts"), "utf8")).sort();
  const want = ["PATCH", "POST", "PUT"];
  fs.rmSync(tmp, { recursive: true, force: true });
  if (JSON.stringify(probe) !== JSON.stringify(want)) {
    console.error(`enumerate-routes: SELF-TEST FAILED — parser returned ${JSON.stringify(probe)}, expected ${JSON.stringify(want)}`);
    process.exit(2);
  }
  console.error("enumerate-routes: self-test ok (all three export forms found, the commented one not)");
}

const mutating = [];
for (const r of routes) for (const m of r.mutating) mutating.push({ method: m, url: r.url, file: r.file });

const report = {
  source: opts.source,
  apiRoot,
  routeFiles: files.length,
  routes,
  mutating,
  mutatingCount: mutating.length,
};

if (files.length === 0) {
  console.error("enumerate-routes: no route files found; an empty matrix is not a pass");
  process.exit(2);
}
if (mutating.length === 0) {
  console.error("enumerate-routes: no mutating methods found in any route; an empty matrix is not a pass");
  process.exit(2);
}

const text = JSON.stringify(report, null, 2);
if (opts.out) fs.writeFileSync(opts.out, text);
process.stdout.write(text + "\n");
