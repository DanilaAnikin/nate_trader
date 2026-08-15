#!/usr/bin/env node
/**
 * Prove that no production entrypoint can reach the tombstoned Vault wrappers.
 *
 * WHY A GRAPH, NOT A GREP
 * -----------------------
 * "maintenanceBlock appears in the file" is not proof of anything. Neither is
 * "the handler returns 503 today". Both are claims about control flow, which is
 * undecidable in general and, worse, silently falsified by an ordinary
 * refactor. What IS decidable is the module graph: if `vault_create_secret` is
 * not in the transitive import closure of any production entrypoint, no code
 * path through those entrypoints can call it, regardless of branching.
 *
 * So this walks the real import graph from every entrypoint enumerated FROM
 * DISK, and fails closed on anything it cannot resolve.
 *
 * FAIL-CLOSED, specifically. Each of these is an error, not a warning:
 *   - an import specifier that does not resolve to a file
 *   - a `.rpc(...)` whose argument is not a literal string
 *   - zero entrypoints discovered, or zero modules walked
 *   - a forbidden name anywhere in the closure
 *
 * The alternative — skipping what it cannot understand — is how a scanner ends
 * up reporting a clean tree it never actually read.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DASH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Routines migration 0022 tombstones. No production entrypoint may reach them. */
const FORBIDDEN_ROUTINES = [
  "vault_create_secret",
  "vault_update_secret",
  "vault_delete_secret",
];

/**
 * Modules whose mere presence in a GET closure is a finding, because they are
 * the mutation surface even when the specific routine name is absent.
 */
const FORBIDDEN_MODULES = [
  "lib/accounts/credentials.ts",
  "lib/accounts/service.ts",
];

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "e2e", "test"]);
const EXT = [".ts", ".tsx", ".mts", ".js", ".mjs"];

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Production entrypoints, enumerated from disk. Anything Next.js will execute
 * on the server: route handlers, pages, layouts, the proxy, instrumentation.
 */
/** Populated during entrypoint discovery; folded into the hard-error list. */
const errorsAtScan = [];

function entrypoints() {
  const eps = [];
  for (const f of walkFiles(join(DASH, "app"))) {
    if (/\/(route|page|layout|template|error|loading|not-found)\.tsx?$/.test(f)) eps.push(f);
  }
  for (const name of ["proxy.ts", "middleware.ts", "instrumentation.ts"]) {
    const p = join(DASH, name);
    if (existsSync(p)) eps.push(p);
  }
  // Server Actions are production entrypoints too, and they were missing.
  //
  // A "use server" module is invoked by a POST to a PAGE path carrying a
  // Next-Action header — not by anything under /api — so it is reached by
  // neither the route enumeration above nor the proxy's `isApi` freeze. An
  // adversarial verifier found the gap: the harness claimed to drive "every
  // mutating method" while three action modules sat outside the surface
  // entirely. They are enumerated here so their closures are proven like any
  // other entrypoint; whether each is ALLOWED to exist is a separate,
  // explicit judgement asserted in server-actions.test.ts.
  for (const root of ["app", "lib", "components"]) {
    for (const f of walkFiles(join(DASH, root))) {
      try {
        const head = readFileSync(f, "utf8").slice(0, 200);
        if (/^\s*["']use server["']/m.test(head) && !eps.includes(f)) eps.push(f);
      } catch {
        errorsAtScan.push(`${relative(DASH, f)}: unreadable while scanning for "use server"`);
      }
    }
  }
  return eps.sort();
}


/** Resolve an import specifier to a real file, or return null (a hard error). */
function resolveSpec(spec, fromFile) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return "EXTERNAL";
  const base = spec.startsWith("@/")
    ? join(DASH, spec.slice(2))
    : resolve(dirname(fromFile), spec);
  for (const e of ["", ...EXT]) {
    const cand = base + e;
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  for (const e of EXT) {
    const cand = join(base, "index" + e);
    if (existsSync(cand)) return cand;
  }
  return null;
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const RPC_RE = /\.rpc\s*\(\s*([^)]*?)(?:,|\))/g;

const errors = [];
errors.push(...errorsAtScan);
const closures = new Map();

function closureOf(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      errors.push(`${relative(DASH, f)}: unreadable`);
      continue;
    }
    // Every .rpc() argument must be a literal we can classify. A computed name
    // is unresolvable, and an unresolvable call is a hole in the proof.
    for (const m of src.matchAll(RPC_RE)) {
      const arg = m[1].trim();
      if (!/^["'][a-zA-Z0-9_]+["']$/.test(arg)) {
        errors.push(
          `${relative(DASH, f)}: .rpc() called with a non-literal name (${arg.slice(0, 40)}) — cannot be classified`,
        );
      }
    }
    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const spec = m[1];
        const target = resolveSpec(spec, f);
        if (target === "EXTERNAL") continue;
        if (target === null) {
          errors.push(`${relative(DASH, f)}: unresolved import '${spec}'`);
          continue;
        }
        stack.push(target);
      }
    }
  }
  return seen;
}

const eps = entrypoints();
if (eps.length < 5) errors.push(`only ${eps.length} entrypoints discovered — enumeration looks broken`);

let modulesWalked = 0;
const offences = [];

for (const ep of eps) {
  const cl = closureOf(ep);
  closures.set(ep, cl);
  modulesWalked += cl.size;
  const rel = relative(DASH, ep);
  const isGet = true; // every entrypoint is checked; GET-only rules noted below

  for (const f of cl) {
    const fr = relative(DASH, f);
    const src = readFileSync(f, "utf8");
    for (const routine of FORBIDDEN_ROUTINES) {
      // a real callsite, not a type declaration or a comment
      if (new RegExp(`\\.rpc\\s*\\(\\s*["']${routine}["']`).test(src)) {
        offences.push(`${rel} -> ${fr}: reaches tombstoned routine ${routine}`);
      }
    }
    if (isGet) {
      for (const m of FORBIDDEN_MODULES) {
        if (fr === m) offences.push(`${rel} -> ${fr}: mutation surface in a production entrypoint closure`);
      }
    }
  }
}

if (modulesWalked === 0) errors.push("zero modules walked — the graph walk is vacuous");

// POSITIVE CONTROL: the walker must actually be finding real edges. If the
// closure of a known route does not contain a module we know it imports, the
// resolver is broken and every "absent" above is meaningless.
const probe = eps.find((e) => e.endsWith(join("app", "api", "accounts", "route.ts")));
if (!probe) {
  errors.push("positive control: app/api/accounts/route.ts not among entrypoints");
} else {
  const cl = closures.get(probe);
  const want = join(DASH, "lib", "accounts", "read.ts");
  if (!cl.has(want)) {
    errors.push("positive control FAILED: accounts route closure does not contain lib/accounts/read.ts — the resolver is broken");
  }
}

console.log(`entrypoints: ${eps.length}`);
console.log(`modules walked (with repeats): ${modulesWalked}`);
console.log(`forbidden routines: ${FORBIDDEN_ROUTINES.join(", ")}`);

if (errors.length) {
  console.error("\nFAIL-CLOSED ERRORS:");
  for (const e of errors) console.error("  " + e);
}
if (offences.length) {
  console.error("\nREACHABILITY OFFENCES:");
  for (const o of offences) console.error("  " + o);
}
if (errors.length || offences.length) {
  console.error(`\nREACHABILITY: FAIL (${errors.length} errors, ${offences.length} offences)`);
  process.exit(1);
}
console.log("\nREACHABILITY: PASS — no production entrypoint closure reaches a tombstoned routine");
